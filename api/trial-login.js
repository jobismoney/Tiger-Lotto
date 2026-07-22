import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });
  }

  try {
    const { code } = req.body || {};
    const trialCode = String(code || '').trim().toUpperCase();

    if (!trialCode) {
      return res.status(400).json({
        ok: false,
        message: 'กรุณากรอกรหัส Trial'
      });
    }

    const rows = await sql`
      select
        id,
        trial_code,
        customer_name,
        status,
        starts_at,
        expires_at,
        workspace_id
      from trial_access
      where upper(trial_code) = ${trialCode}
      limit 1
    `;

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'ไม่พบรหัส Trial นี้'
      });
    }

    const trial = rows[0];

    if (trial.status !== 'ACTIVE') {
      return res.status(403).json({
        ok: false,
        message: 'สิทธิ์ Trial นี้ถูกปิดใช้งาน'
      });
    }

    const now = new Date();
    const startsAt = new Date(trial.starts_at);
    const expiresAt = new Date(trial.expires_at);

    if (now < startsAt) {
      return res.status(403).json({
        ok: false,
        message: 'สิทธิ์ Trial นี้ยังไม่ถึงเวลาเริ่มใช้งาน'
      });
    }

    if (now >= expiresAt) {
      return res.status(403).json({
        ok: false,
        message: 'สิทธิ์ Trial นี้หมดอายุแล้ว'
      });
    }

    const remainingMs = expiresAt.getTime() - now.getTime();
    const remainingDays = Math.ceil(remainingMs / 86400000);

    return res.status(200).json({
      ok: true,
      message: 'เข้าสู่ T999 Web Trial สำเร็จ',
      customerName: trial.customer_name || '',
      workspaceId: trial.workspace_id || '',
      startsAt: trial.starts_at,
      expiresAt: trial.expires_at,
      remainingDays
    });

  } catch (error) {
    console.error('trial-login error:', error);

    return res.status(500).json({
      ok: false,
      message: 'ระบบไม่สามารถตรวจสอบ Trial ได้ในขณะนี้'
    });
  }
}
