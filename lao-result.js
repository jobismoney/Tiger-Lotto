// api/lao-result.js
// Vercel Serverless Function — ดึงผลหวยลาวจาก thethaiger
// deploy ที่ tiger999.online/api/lao-result

export default async function handler(req, res) {
  // CORS — อนุญาต tiger999.online เท่านั้น
  res.setHeader('Access-Control-Allow-Origin', 'https://tiger999.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 นาที

  try {
    // Step 1: ดึง index หวยลาว เพื่อหา URL งวดล่าสุด
    const indexRes = await fetch('https://thethaiger.com/th/check-lottery/laos-lottery/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tiger999/1.0)' }
    });
    const indexHtml = await indexRes.text();

    // หา link งวดล่าสุด
    const linkMatch = indexHtml.match(/href="(https:\/\/thethaiger\.com\/th\/news\/\d+\/?)"/)
    if (!linkMatch) throw new Error('ไม่พบลิงก์งวดล่าสุด');

    // Step 2: ดึงหน้างวดนั้น
    const pageRes = await fetch(linkMatch[1], {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tiger999/1.0)' }
    });
    const pageHtml = await pageRes.text();

    // Parse เลข 6 ตัว
    const m6 = pageHtml.match(/เลข\s*6\s*ตัว\s*[:\s]*(\d{6})/);
    if (!m6) throw new Error('ยังไม่มีผล 6 ตัว');
    const result = m6[1];

    // Parse วันที่
    const mDate = pageHtml.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const date = mDate ? mDate[1] : '';

    // Parse ตารางย้อนหลัง
    const history = [];
    const rows = pageHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
    rows.forEach(row => {
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
      if (cells.length < 2) return;
      const dateCell = cells[0].replace(/<[^>]+>/g, '').trim();
      const sixCell  = cells[1].replace(/<[^>]+>/g, '').trim();
      if (!/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(dateCell)) return;
      if (!/^\d{6}$/.test(sixCell)) return;
      history.push({ date: dateCell, result: sixCell });
    });

    res.status(200).json({ ok: true, result, date, history });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
