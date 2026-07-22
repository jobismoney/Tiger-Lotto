import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function makeWorkspaceId(trialCode) {
  const safeCode = String(trialCode || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

  const randomPart = Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase();

  return `WS-${safeCode}-${randomPart}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const rows = await sql`
        select
          id,
          trial_code,
          customer_name,
          status,
          starts_at,
          expires_at,
          workspace_id,
          created_at,
          updated_at
        from trial_access
        order by created_at desc
      `;

      return res.status(200).json({
        ok: true,
        trials: rows.map((row) => ({
          id: row.id,
          trialCode: row.trial_code,
          customerName: row.customer_name,
          status: row.status,
          startsAt: row.starts_at,
          expiresAt: row.expires_at,
          workspaceId: row.workspace_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }

    if (req.method === 'POST') {
      const {
        trialCode,
        customerName,
        startsAt,
        expiresAt
      } = req.body || {};

      const code = String(trialCode || '')
        .trim()
        .toUpperCase();

      const customer = String(customerName || '').trim();

      if (!code) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณากรอกรหัส Trial'
        });
      }

      if (!startsAt || !expiresAt) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณากำหนดวันเวลาเริ่มและหมดอายุ'
        });
      }

      const startDate = new Date(startsAt);
      const expireDate = new Date(expiresAt);

      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(expireDate.getTime())
      ) {
        return res.status(400).json({
          ok: false,
          message: 'รูปแบบวันเวลาไม่ถูกต้อง'
        });
      }

      if (expireDate <= startDate) {
        return res.status(400).json({
          ok: false,
          message: 'วันหมดอายุต้องอยู่หลังวันเริ่มใช้งาน'
        });
      }

      const existing = await sql`
        select id
        from trial_access
        where upper(trial_code) = ${code}
        limit 1
      `;

      if (existing.length) {
        return res.status(409).json({
          ok: false,
          message: 'รหัส Trial นี้มีอยู่แล้ว'
        });
      }

      let workspaceId = makeWorkspaceId(code);

      let workspaceExists = await sql`
        select id
        from trial_access
        where workspace_id = ${workspaceId}
        limit 1
      `;

      while (workspaceExists.length) {
        workspaceId = makeWorkspaceId(code);

        workspaceExists = await sql`
          select id
          from trial_access
          where workspace_id = ${workspaceId}
          limit 1
        `;
      }

      const inserted = await sql`
        insert into trial_access (
          trial_code,
          customer_name,
          status,
          starts_at,
          expires_at,
          workspace_id,
          created_at,
          updated_at
        )
        values (
          ${code},
          ${customer},
          'ACTIVE',
          ${startDate.toISOString()},
          ${expireDate.toISOString()},
          ${workspaceId},
          now(),
          now()
        )
        returning
          id,
          trial_code,
          customer_name,
          status,
          starts_at,
          expires_at,
          workspace_id
      `;

      const trial = inserted[0];

      await sql`
        insert into trial_workspaces (
          workspace_id,
          trial_access_id,
          created_at,
          updated_at
        )
        values (
          ${workspaceId},
          ${trial.id},
          now(),
          now()
        )
      `;

      return res.status(201).json({
        ok: true,
        message: 'สร้าง Trial สำเร็จ',
        trial: {
          id: trial.id,
          trialCode: trial.trial_code,
          customerName: trial.customer_name,
          status: trial.status,
          startsAt: trial.starts_at,
          expiresAt: trial.expires_at,
          workspaceId: trial.workspace_id
        }
      });
    }

    if (req.method === 'PATCH') {
      const {
        id,
        action,
        status
      } = req.body || {};

      const trialId = Number(id);

      if (!Number.isInteger(trialId) || trialId <= 0) {
        return res.status(400).json({
          ok: false,
          message: 'Trial ID ไม่ถูกต้อง'
        });
      }

      const existing = await sql`
        select
          id,
          status,
          expires_at
        from trial_access
        where id = ${trialId}
        limit 1
      `;

      if (!existing.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบ Trial'
        });
      }

      if (action === 'EXTEND_7_DAYS') {
        const currentExpiry = new Date(existing[0].expires_at);
        const now = new Date();

        const baseTime =
          currentExpiry > now
            ? currentExpiry
            : now;

        const newExpiry = new Date(
          baseTime.getTime() +
          7 * 24 * 60 * 60 * 1000
        );

        const updated = await sql`
          update trial_access
          set
            expires_at = ${newExpiry.toISOString()},
            updated_at = now()
          where id = ${trialId}
          returning
            id,
            trial_code,
            customer_name,
            status,
            starts_at,
            expires_at,
            workspace_id
        `;

        return res.status(200).json({
          ok: true,
          message: 'ต่ออายุ Trial อีก 7 วันแล้ว',
          trial: updated[0]
        });
      }

      if (action === 'SET_STATUS') {
        const nextStatus =
          String(status || '')
            .trim()
            .toUpperCase();

        if (
          nextStatus !== 'ACTIVE' &&
          nextStatus !== 'DISABLED'
        ) {
          return res.status(400).json({
            ok: false,
            message: 'สถานะไม่ถูกต้อง'
          });
        }

        const updated = await sql`
          update trial_access
          set
            status = ${nextStatus},
            updated_at = now()
          where id = ${trialId}
          returning
            id,
            trial_code,
            customer_name,
            status,
            starts_at,
            expires_at,
            workspace_id
        `;

        return res.status(200).json({
          ok: true,
          message:
            nextStatus === 'ACTIVE'
              ? 'เปิดใช้งาน Trial แล้ว'
              : 'ปิดใช้งาน Trial แล้ว',
          trial: updated[0]
        });
      }

      return res.status(400).json({
        ok: false,
        message: 'ไม่รู้จักคำสั่งนี้'
      });
    }

    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });
  } catch (error) {
    console.error('trials api error:', error);

    return res.status(500).json({
      ok: false,
      message: 'ระบบ Trial Admin เกิดข้อผิดพลาด'
    });
  }
}
