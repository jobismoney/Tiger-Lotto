import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  try {
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
          agent_code,
          agent_name,
          enabled,
          created_at,
          updated_at
        from workspace_agents
        where workspace_id = ${workspaceId}
        order by agent_code asc
      `;

      return res.status(200).json({
        ok: true,
        agents: rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          agentCode: row.agent_code,
          agentName: row.agent_name,
          enabled: row.enabled,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }

    if (req.method === 'POST') {
      const {
        workspaceId,
        agentCode,
        agentName
      } = req.body || {};

      const workspace =
        String(workspaceId || '').trim();

      const code =
        String(agentCode || '')
          .trim()
          .toUpperCase();

      const name =
        String(agentName || '').trim();

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!code) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณากรอกรหัส Agent'
        });
      }

      const workspaceRows = await sql`
        select
          id,
          status,
          starts_at,
          expires_at
        from trial_access
        where workspace_id = ${workspace}
        limit 1
      `;

      if (!workspaceRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบ Workspace นี้'
        });
      }

      const trial = workspaceRows[0];
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

      const existing = await sql`
        select id
        from workspace_agents
        where workspace_id = ${workspace}
          and upper(agent_code) = ${code}
        limit 1
      `;

      if (existing.length) {
        return res.status(409).json({
          ok: false,
          message: 'รหัส Agent นี้มีอยู่แล้ว'
        });
      }

      const inserted = await sql`
        insert into workspace_agents (
          workspace_id,
          agent_code,
          agent_name,
          enabled,
          created_at,
          updated_at
        )
        values (
          ${workspace},
          ${code},
          ${name},
          true,
          now(),
          now()
        )
        returning
          id,
          workspace_id,
          agent_code,
          agent_name,
          enabled,
          created_at,
          updated_at
      `;

      const row = inserted[0];

      return res.status(201).json({
        ok: true,
        message: 'เพิ่ม Agent สำเร็จ',
        agent: {
          id: row.id,
          workspaceId: row.workspace_id,
          agentCode: row.agent_code,
          agentName: row.agent_name,
          enabled: row.enabled,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      });
    }

    if (req.method === 'PATCH') {
      const {
        workspaceId,
        id,
        enabled
      } = req.body || {};

      const workspace =
        String(workspaceId || '').trim();

      const agentId =
        Number(id);

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (
        !Number.isInteger(agentId) ||
        agentId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Agent ID ไม่ถูกต้อง'
        });
      }

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          ok: false,
          message: 'สถานะ Agent ไม่ถูกต้อง'
        });
      }

      const existing = await sql`
        select id
        from workspace_agents
        where id = ${agentId}
          and workspace_id = ${workspace}
        limit 1
      `;

      if (!existing.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบ Agent นี้ใน Workspace'
        });
      }

      const updated = await sql`
        update workspace_agents
        set
          enabled = ${enabled},
          updated_at = now()
        where id = ${agentId}
          and workspace_id = ${workspace}
        returning
          id,
          workspace_id,
          agent_code,
          agent_name,
          enabled,
          created_at,
          updated_at
      `;

      const row = updated[0];

      return res.status(200).json({
        ok: true,
        message:
          enabled
            ? 'เปิดใช้งาน Agent แล้ว'
            : 'ปิดใช้งาน Agent แล้ว',
        agent: {
          id: row.id,
          workspaceId: row.workspace_id,
          agentCode: row.agent_code,
          agentName: row.agent_name,
          enabled: row.enabled,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      });
    }

    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });
  } catch (error) {
    console.error('agents api error:', error);

    return res.status(500).json({
      ok: false,
      message: 'ระบบ Agent เกิดข้อผิดพลาด'
    });
  }
}
