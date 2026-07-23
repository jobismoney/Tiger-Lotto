import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

export default async function handler(req, res) {
  try {

    // =========================================================
    // GET : ดูรายการงวดใน Workspace
    // รองรับ filter:
    // ?workspaceId=...
    // &status=ACTIVE
    // &marketCode=TH
    // =========================================================
    if (req.method === 'GET') {

      const workspaceId =
        clean(req.query?.workspaceId);

      const status =
        upper(req.query?.status);

      const marketCode =
        upper(req.query?.marketCode);

      if (!workspaceId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      let rows;

      if (status && marketCode) {

        rows = await sql`
          select
            id,
            workspace_id,
            market_code,
            draw_code,
            draw_name,
            status,
            opens_at,
            closes_at,
            created_at,
            updated_at
          from workspace_draws
          where workspace_id = ${workspaceId}
            and upper(status) = ${status}
            and upper(market_code) = ${marketCode}
          order by created_at desc
        `;

      } else if (status) {

        rows = await sql`
          select
            id,
            workspace_id,
            market_code,
            draw_code,
            draw_name,
            status,
            opens_at,
            closes_at,
            created_at,
            updated_at
          from workspace_draws
          where workspace_id = ${workspaceId}
            and upper(status) = ${status}
          order by created_at desc
        `;

      } else if (marketCode) {

        rows = await sql`
          select
            id,
            workspace_id,
            market_code,
            draw_code,
            draw_name,
            status,
            opens_at,
            closes_at,
            created_at,
            updated_at
          from workspace_draws
          where workspace_id = ${workspaceId}
            and upper(market_code) = ${marketCode}
          order by created_at desc
        `;

      } else {

        rows = await sql`
          select
            id,
            workspace_id,
            market_code,
            draw_code,
            draw_name,
            status,
            opens_at,
            closes_at,
            created_at,
            updated_at
          from workspace_draws
          where workspace_id = ${workspaceId}
          order by created_at desc
        `;
      }

      return res.status(200).json({
        ok: true,
        draws: rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspace_id,
          marketCode: row.market_code,
          drawCode: row.draw_code,
          drawName: row.draw_name || '',
          status: row.status,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }


    // =========================================================
    // POST : M สร้างงวดใหม่
    // =========================================================
    if (req.method === 'POST') {

      const {
        workspaceId,
        marketCode,
        drawCode,
        drawName,
        opensAt,
        closesAt
      } = req.body || {};

      const workspace =
        clean(workspaceId);

      const market =
        upper(marketCode);

      const code =
        upper(drawCode);

      const name =
        clean(drawName);

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!market) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณาระบุตลาด'
        });
      }

      if (!code) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณาระบุรหัสงวด'
        });
      }


      // ตรวจ Workspace ยังใช้งานได้
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

      const trial =
        workspaceRows[0];

      const now =
        new Date();

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
        from workspace_draws
        where workspace_id = ${workspace}
          and upper(market_code) = ${market}
          and upper(draw_code) = ${code}
        limit 1
      `;

      if (existing.length) {
        return res.status(409).json({
          ok: false,
          message: 'งวดนี้มีอยู่แล้ว'
        });
      }


      const openDate =
        opensAt
          ? new Date(opensAt)
          : new Date();

      const closeDate =
        closesAt
          ? new Date(closesAt)
          : null;


      if (
        Number.isNaN(
          openDate.getTime()
        )
      ) {
        return res.status(400).json({
          ok: false,
          message: 'เวลาเปิดงวดไม่ถูกต้อง'
        });
      }

      if (
        closeDate &&
        Number.isNaN(
          closeDate.getTime()
        )
      ) {
        return res.status(400).json({
          ok: false,
          message: 'เวลาปิดงวดไม่ถูกต้อง'
        });
      }

      if (
        closeDate &&
        closeDate <= openDate
      ) {
        return res.status(400).json({
          ok: false,
          message: 'เวลาปิดงวดต้องมากกว่าเวลาเปิด'
        });
      }


      const inserted = await sql`
        insert into workspace_draws (
          workspace_id,
          market_code,
          draw_code,
          draw_name,
          status,
          opens_at,
          closes_at,
          created_at,
          updated_at
        )
        values (
          ${workspace},
          ${market},
          ${code},
          ${name},
          'ACTIVE',
          ${openDate.toISOString()},
          ${closeDate
            ? closeDate.toISOString()
            : null},
          now(),
          now()
        )
        returning
          id,
          workspace_id,
          market_code,
          draw_code,
          draw_name,
          status,
          opens_at,
          closes_at,
          created_at,
          updated_at
      `;

      const row =
        inserted[0];

      return res.status(201).json({
        ok: true,
        message: 'สร้างงวดสำเร็จ',
        draw: {
          id: row.id,
          workspaceId: row.workspace_id,
          marketCode: row.market_code,
          drawCode: row.draw_code,
          drawName: row.draw_name || '',
          status: row.status,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      });
    }


    // =========================================================
    // PATCH : M เปลี่ยนสถานะงวด
    //
    // action:
    // SET_STATUS
    //
    // status:
    // ACTIVE
    // CLOSED
    // DISABLED
    // =========================================================
    if (req.method === 'PATCH') {

      const {
        action,
        workspaceId,
        id,
        status
      } = req.body || {};

      const command =
        upper(action);

      const workspace =
        clean(workspaceId);

      const drawId =
        Number(id);

      const newStatus =
        upper(status);


      if (command !== 'SET_STATUS') {
        return res.status(400).json({
          ok: false,
          message: 'Action ไม่ถูกต้อง'
        });
      }

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (
        !Number.isInteger(drawId) ||
        drawId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Draw ID ไม่ถูกต้อง'
        });
      }

      if (
        ![
          'ACTIVE',
          'CLOSED',
          'DISABLED'
        ].includes(newStatus)
      ) {
        return res.status(400).json({
          ok: false,
          message: 'สถานะงวดไม่ถูกต้อง'
        });
      }


      const existing = await sql`
        select
          id,
          market_code,
          draw_code
        from workspace_draws
        where id = ${drawId}
          and workspace_id = ${workspace}
        limit 1
      `;

      if (!existing.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบงวดนี้ใน Workspace'
        });
      }


      const updated = await sql`
        update workspace_draws
        set
          status = ${newStatus},
          updated_at = now()
        where id = ${drawId}
          and workspace_id = ${workspace}
        returning
          id,
          workspace_id,
          market_code,
          draw_code,
          draw_name,
          status,
          opens_at,
          closes_at,
          created_at,
          updated_at
      `;

      const row =
        updated[0];

      return res.status(200).json({
        ok: true,
        message: 'อัปเดตสถานะงวดแล้ว',
        draw: {
          id: row.id,
          workspaceId: row.workspace_id,
          marketCode: row.market_code,
          drawCode: row.draw_code,
          drawName: row.draw_name || '',
          status: row.status,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
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

    console.error(
      'draws api error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message: 'ระบบงวดเกิดข้อผิดพลาด'
    });
  }
}
