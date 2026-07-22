export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      message: "กรุณากรอกรหัสทดลองใช้งาน"
    });
  }

  /*
    รหัสจริงจะไม่เก็บใน GitHub
    แต่จะเก็บใน Vercel Environment Variable ชื่อ:

    T999_TRIAL_CODES

    รูปแบบตัวอย่าง:
    TEST001|2026-07-22T00:00:00+07:00|2026-07-29T00:00:00+07:00,
    TEST002|2026-07-23T00:00:00+07:00|2026-07-30T00:00:00+07:00
  */

  const rawCodes = process.env.T999_TRIAL_CODES || "";

  const trialCodes = rawCodes
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const [trialCode, startsAt, expiresAt] = row.split("|");

      return {
        code: String(trialCode || "").trim().toUpperCase(),
        startsAt: String(startsAt || "").trim(),
        expiresAt: String(expiresAt || "").trim()
      };
    });

  const trial = trialCodes.find(
    (item) => item.code === code
  );

  if (!trial) {
    return res.status(401).json({
      ok: false,
      message: "รหัสทดลองใช้งานไม่ถูกต้อง"
    });
  }

  const now = Date.now();

  const startsAt = new Date(trial.startsAt).getTime();
  const expiresAt = new Date(trial.expiresAt).getTime();

  if (
    !Number.isFinite(startsAt) ||
    !Number.isFinite(expiresAt)
  ) {
    return res.status(500).json({
      ok: false,
      message: "ข้อมูลสิทธิ์ทดลองไม่สมบูรณ์ กรุณาติดต่อผู้ดูแลระบบ"
    });
  }

  if (now < startsAt) {
    return res.status(403).json({
      ok: false,
      message: "รหัสนี้ยังไม่ถึงเวลาเริ่มใช้งาน"
    });
  }

  if (now >= expiresAt) {
    return res.status(403).json({
      ok: false,
      expired: true,
      message: "รหัสทดลองใช้งานนี้หมดอายุแล้ว"
    });
  }

  const remainingMs = expiresAt - now;
  const remainingDays = Math.max(
    1,
    Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
  );

  return res.status(200).json({
    ok: true,

    message:
      `เข้าสู่ T999 Web Trial สำเร็จ\n` +
      `เหลือสิทธิ์ทดลองประมาณ ${remainingDays} วัน`,

    trial: {
      expiresAt: trial.expiresAt,

      limits: {
        maxAgents: 5,
        maxSlipsPerAgent: 30,
        maxTotalSlips: 150
      }
    }
  });
}
