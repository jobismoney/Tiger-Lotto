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

    // =========================================================
    // POST : R รับรูปเข้า A ภายใต้งวดที่เลือก
    // =========================================================
    if (req.method === 'POST') {

      const {
        workspaceId,
        agentCode,
        sourceFilename,
        drawCode
      } = req.body || {};

      const workspace =
        String(workspaceId || '').trim();

      const agent =
        String(agentCode || '')
          .trim()
          .toUpperCase();

      const filename =
        String(sourceFilename || '').trim();

      const draw =
        String(drawCode || '')
          .trim()
          .toUpperCase();


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

      if (!draw) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณาเลือกงวด'
        });
      }


      // =======================================================
      // ตรวจ Workspace
      // =======================================================
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

      const trial =
        trialRows[0];

      const now =
        new Date();


      if (trial.status !== 'ACTIVE') {
        return res.status(403).json({
          ok: false,
          message: 'Workspace นี้ถูกปิดใช้งาน'
        });
      }

      if (
        now <
        new Date(trial.starts_at)
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'Workspace นี้ยังไม่ถึงเวลาเริ่มใช้งาน'
        });
      }

      if (
        now >=
        new Date(trial.expires_at)
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'Workspace นี้หมดอายุแล้ว'
        });
      }


      // =======================================================
      // ตรวจงวด
      // ต้องอยู่ใน Workspace เดียวกัน
      // และต้อง ACTIVE
      // =======================================================
      const drawRows = await sql`
        select
          id,
          market_code,
          draw_code,
          draw_name,
          status,
          opens_at,
          closes_at
        from workspace_draws
        where workspace_id = ${workspace}
          and upper(draw_code) = ${draw}
        limit 1
      `;


      if (!drawRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบงวดนี้'
        });
      }


      const drawRow =
        drawRows[0];


      if (drawRow.status !== 'ACTIVE') {
        return res.status(403).json({
          ok: false,
          message:
            'งวดนี้ไม่ได้อยู่ในสถานะ ACTIVE'
        });
      }


      if (
        drawRow.opens_at &&
        now <
        new Date(drawRow.opens_at)
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'งวดนี้ยังไม่ถึงเวลาเปิด'
        });
      }


      if (
        drawRow.closes_at &&
        now >=
        new Date(drawRow.closes_at)
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'งวดนี้ถึงเวลาปิดแล้ว'
        });
      }


      // =======================================================
      // ตรวจ Agent
      // =======================================================
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
          message:
            'ไม่พบ Agent นี้ใน Workspace'
        });
      }


      if (!agentRows[0].enabled) {
        return res.status(403).json({
          ok: false,
          message:
            'Agent นี้ถูกปิดใช้งาน'
        });
      }


      // =======================================================
      // สร้าง Slip ID + File ID
      // =======================================================
      let slipId =
        makeId('SLIP');

      let fileId =
        makeId('FILE');


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

        slipId =
          makeId('SLIP');

        fileId =
          makeId('FILE');


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


      // =======================================================
      // บันทึกเข้า Intake + Queue
      // =======================================================
      const inserted = await sql`
        insert into intake_slips (
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          agent_code,
          draw_code,
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
          ${draw},
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
          draw_code,
          queue_status,
          received_at
      `;


      const row =
        inserted[0];


      return res.status(201).json({
        ok: true,
        message:
          'รับรูปเข้า Agent สำเร็จ',

        slip: {
          id:
            row.id,

          workspaceId:
            row.workspace_id,

          slipId:
            row.slip_id,

          fileId:
            row.file_id,

          sourceFilename:
            row.source_filename,

          agentCode:
            row.agent_code,

          drawCode:
            row.draw_code,

          queueStatus:
            row.queue_status,

          receivedAt:
            row.received_at
        }
      });
    }


    // =========================================================
    // GET : ดูโพยที่ R รับเข้า
    // filter ตาม Workspace และ drawCode ได้
    // =========================================================
    if (req.method === 'GET') {

      const workspaceId =
        String(
          req.query?.workspaceId || ''
        ).trim();

      const drawCode =
        String(
          req.query?.drawCode || ''
        )
        .trim()
        .toUpperCase();


      if (!workspaceId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }


      let rows;


      if (drawCode) {

        rows = await sql`
          select
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at
          from intake_slips
          where workspace_id = ${workspaceId}
            and upper(
              coalesce(
                draw_code,
                ''
              )
            ) = ${drawCode}
          order by
            received_at asc,
            id asc
          limit 500
        `;

      } else {

        rows = await sql`
          select
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at
          from intake_slips
          where workspace_id = ${workspaceId}
          order by
            received_at asc,
            id asc
          limit 500
        `;
      }


      return res.status(200).json({
        ok: true,

        slips:
          rows.map((row) => ({
            id:
              row.id,

            workspaceId:
              row.workspace_id,

            slipId:
              row.slip_id,

            fileId:
              row.file_id,

            sourceFilename:
              row.source_filename,

            agentCode:
              row.agent_code,

            drawCode:
              row.draw_code || '',

            queueStatus:
              row.queue_status,

            assignedSubkey:
              row.assigned_subkey || '',

            receivedAt:
              row.received_at,

            claimedAt:
              row.claimed_at,

            completedAt:
              row.completed_at
          }))
      });
    }


    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });

  } catch (error) {

    console.error(
      'intake api error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบรับรูปเกิดข้อผิดพลาด'
    });
  }
}
