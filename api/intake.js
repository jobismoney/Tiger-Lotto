import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function makeId(prefix) {
  const timePart = Date.now()
    .toString(36)
    .toUpperCase();

  const randomPart = Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase();

  return `${prefix}-${timePart}-${randomPart}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const {
        workspaceId,
        agentCode,
        sourceFilename
      } = req.body || {};

      const workspace = String(workspaceId || '').trim();
      const agent = String(agentCode || '').trim().toUpperCase();
      const filename = String(sourceFilename || '').trim();

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!agent) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณาเลือก Agent'
        });
      }

      if (!filename) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบชื่อไฟล์รูป'
        });
      }

      const trialRows = await sql`
        select
          id,
          status,
          starts_at,
          expires_at
        from trial_access
        where workspace_id = ${workspace}
        limit 1
      `;

      if (!trialRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบ Workspace นี้'
        });
      }

      const trial = trialRows[0];
      const now = new Date();

      if (trial.status !== 'ACTIVE') {
        return res.status(403).json({
          ok: false,
          message: 'Workspace นี้ถูกปิดใช้งาน'
        });
      }

      if (now < new Date(trial.starts_at)) {
        return res.status(403).json({
          ok: false,
          message: 'Workspace นี้ยังไม่ถึงเวลาเริ่มใช้งาน'
        });
      }

      if (now >= new Date(trial.expires_at)) {
        return res.status(403).json({
          ok: false,
          message: 'Workspace นี้หมดอายุแล้ว'
        });
      }

      const agentRows = await sql`
        select
          id,
          agent_code,
          agent_name,
          enabled
        from workspace_agents
        where workspace_id = ${workspace}
          and upper(agent_code) = ${agent}
        limit 1
      `;

      if (!agentRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบ Agent นี้ใน Workspace'
        });
      }

      if (!agentRows[0].enabled) {
        return res.status(403).json({
          ok: false,
          message: 'Agent นี้ถูกปิดใช้งาน'
        });
      }

      let slipId = makeId('SLIP');
      let fileId = makeId('FILE');

      let duplicate = await sql`
        select id
        from intake_slips
        where workspace_id = ${workspace}
          and (
            slip_id = ${slipId}
            or file_id = ${fileId}
          )
        limit 1
      `;

      while (duplicate.length) {
        slipId = makeId('SLIP');
        fileId = makeId('FILE');

        duplicate = await sql`
          select id
          from intake_slips
          where workspace_id = ${workspace}
            and (
              slip_id = ${slipId}
              or file_id = ${fileId}
            )
          limit 1
        `;
      }

      const inserted = await sql`
        insert into intake_slips (
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          agent_code,
          queue_status,
          received_at,
          created_at,
          updated_at
        )
        values (
          ${workspace},
          ${slipId},
          ${fileId},
          ${filename},
          ${agent},
          'WAITING',
          now(),
          now(),
          now()
        )
        returning
          id,
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          agent_code,
          queue_status,
          received_at
      `;

      const row = inserted[0];

      return res.status(201).json({
        ok: true,
        message: 'รับรูปเข้า Agent สำเร็จ',
        slip: {
          id: row.id,
          workspaceId: row.workspace_id,
          slipId: row.slip_id,
          fileId: row.file_id,
          sourceFilename: row.source_filename,
          agentCode: row.agent_code,
          queueStatus: row.queue_status,
          receivedAt: row.received_at
        }
      });
    }

    if (req.method === 'GET') {
      const workspaceId =
        String(req.query?.workspaceId || '').trim();

      if (!workspaceId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      const rows = await sql`
        select
          id,
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          agent_code,
          queue_status,
          received_at,
          completed_at
        from intake_slips
        where workspace_id = ${workspaceId}
        order by received_at asc
        limit 500
      `;

      return res.status(200).json({
        ok: true,
        slips: rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          slipId: row.slip_id,
          fileId: row.file_id,
          sourceFilename: row.source_filename,
          agentCode: row.agent_code,
          queueStatus: row.queue_status,
          receivedAt: row.received_at,
          completedAt: row.completed_at
        }))
      });
    }

    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });
  } catch (error) {
    console.error('intake api error:', error);

    return res.status(500).json({
      ok: false,
      message: 'ระบบรับรูปเกิดข้อผิดพลาด'
    });
  }
}
