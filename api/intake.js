import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

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
    // POST
    // R รับรูปเข้า A ภายใต้งวดที่เลือก
    // =========================================================
    if (req.method === 'POST') {

      const {
        workspaceId,
        agentCode,
        sourceFilename,
        drawCode,
        originLocation,
        mimeType,
        fileSizeBytes,
        checksumSha256
      } = req.body || {};

      const workspace =
        clean(workspaceId);

      const agent =
        upper(agentCode);

      const filename =
        clean(sourceFilename);

      const draw =
        upper(drawCode);

      const origin =
        clean(originLocation);

      const mime =
        clean(mimeType);

      const checksum =
        clean(checksumSha256)
          .toLowerCase();

      const size =
        fileSizeBytes === undefined ||
        fileSizeBytes === null ||
        fileSizeBytes === ''
          ? null
          : Number(fileSizeBytes);

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!draw) {
        return res.status(400).json({
          ok: false,
          message: 'กรุณาเลือกงวด'
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

      if (
        size !== null &&
        (
          !Number.isSafeInteger(size) ||
          size < 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          message: 'ขนาดไฟล์ไม่ถูกต้อง'
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

      let duplicate =
        await sql`
          select 1
          from intake_slips
          where workspace_id = ${workspace}
            and (
              slip_id = ${slipId}
              or file_id = ${fileId}
            )

          union all

          select 1
          from file_assets
          where workspace_id = ${workspace}
            and file_id = ${fileId}

          limit 1
        `;

      while (duplicate.length) {

        slipId =
          makeId('SLIP');

        fileId =
          makeId('FILE');

        duplicate =
          await sql`
            select 1
            from intake_slips
            where workspace_id = ${workspace}
              and (
                slip_id = ${slipId}
                or file_id = ${fileId}
              )

            union all

            select 1
            from file_assets
            where workspace_id = ${workspace}
              and file_id = ${fileId}

            limit 1
          `;
      }

      // =======================================================
      // บันทึก Asset + Slip แบบ Atomic
      // =======================================================
      const inserted = await sql`
        with new_asset as (

          insert into file_assets (
            workspace_id,
            draw_code,
            file_id,
            source_filename,
            origin_role,
            origin_location,
            mime_type,
            file_size_bytes,
            checksum_sha256,
            status,
            created_at,
            updated_at
          )

          values (
            ${workspace},
            ${draw},
            ${fileId},
            ${filename},
            'R',
            ${origin || null},
            ${mime || null},
            ${size},
            ${checksum || null},
            'AVAILABLE',
            now(),
            now()
          )

          returning file_id
        ),

        new_slip as (

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

          select
            ${workspace},
            ${slipId},
            new_asset.file_id,
            ${filename},
            ${agent},
            ${draw},
            'WAITING',
            now(),
            now(),
            now()

          from new_asset

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
        )

        select *
        from new_slip
      `;

      if (!inserted.length) {
        throw new Error(
          'ไม่สามารถสร้างทะเบียนรูปและโพยได้'
        );
      }

      const row =
        inserted[0];

      return res.status(201).json({
        ok: true,

        message:
          'รับรูปเข้า Agent สำเร็จ',

        slip: {
          id: row.id,
          workspaceId: row.workspace_id,
          slipId: row.slip_id,
          fileId: row.file_id,
          sourceFilename: row.source_filename,
          agentCode: row.agent_code,
          drawCode: row.draw_code,
          queueStatus: row.queue_status,
          receivedAt: row.received_at
        },

        asset: {
          workspaceId:
            row.workspace_id,

          drawCode:
            row.draw_code,

          fileId:
            row.file_id,

          sourceFilename:
            row.source_filename,

          originRole: 'R',
          status: 'AVAILABLE'
        }
      });
    }


    // =========================================================
    // DELETE
    // R ลบโพยที่ยัง WAITING เท่านั้น
    //
    // IMPORTANT:
    // - ไม่ physical delete
    // - เปลี่ยนเป็น CANCELLED
    // - ถ้า S รับไปแล้วจะลบไม่ได้
    // =========================================================
    if (req.method === 'DELETE') {

      const {
        workspaceId,
        slipId
      } = req.body || {};

      const workspace =
        clean(workspaceId);

      const slip =
        clean(slipId);

      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!slip) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Slip ID'
        });
      }

      // -------------------------------------------------------
      // ตรวจรายการก่อน
      // -------------------------------------------------------
      const existingRows = await sql`
        select
          id,
          slip_id,
          file_id,
          source_filename,
          queue_status,
          assigned_subkey
        from intake_slips
        where workspace_id = ${workspace}
          and slip_id = ${slip}
        limit 1
      `;

      if (!existingRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบโพยนี้'
        });
      }

      const existing =
        existingRows[0];

      if (
        existing.queue_status !== 'WAITING' ||
        existing.assigned_subkey
      ) {
        return res.status(409).json({
          ok: false,
          message:
            'ลบไม่ได้ เพราะโพยนี้ถูก S รับงานแล้วหรือไม่ได้อยู่ในสถานะ WAITING'
        });
      }

      // -------------------------------------------------------
      // Soft Cancel Slip + Asset แบบ Atomic
      // -------------------------------------------------------
      const cancelled = await sql`
        with cancelled_slip as (

          update intake_slips

          set
            queue_status = 'CANCELLED',
            updated_at = now()

          where workspace_id = ${workspace}
            and slip_id = ${slip}
            and queue_status = 'WAITING'
            and assigned_subkey is null

          returning
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            queue_status
        ),

        cancelled_asset as (

          update file_assets a

          set
            status = 'CANCELLED',
            updated_at = now()

          from cancelled_slip s

          where a.workspace_id = s.workspace_id
            and a.file_id = s.file_id

          returning
            a.file_id
        )

        select
          id,
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          queue_status

        from cancelled_slip
      `;

      if (!cancelled.length) {
        return res.status(409).json({
          ok: false,
          message:
            'ไม่สามารถลบโพยได้ สถานะอาจถูกเปลี่ยนโดยผู้ใช้อื่นแล้ว'
        });
      }

      const row =
        cancelled[0];

      return res.status(200).json({
        ok: true,

        message:
          'ลบโพยออกจาก Queue แล้ว',

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

          queueStatus:
            row.queue_status
        }
      });
    }


    // =========================================================
    // GET
    // ดูโพยที่ R รับเข้า
    // =========================================================
    if (req.method === 'GET') {

      const workspaceId =
        clean(req.query?.workspaceId);

      const drawCode =
        upper(req.query?.drawCode);

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
            s.id,
            s.workspace_id,
            s.slip_id,
            s.file_id,
            s.source_filename,
            s.agent_code,
            s.draw_code,
            s.queue_status,
            s.assigned_subkey,
            s.received_at,
            s.claimed_at,
            s.completed_at,

            a.status as asset_status,
            a.mime_type,
            a.file_size_bytes,
            a.checksum_sha256

          from intake_slips s

          left join file_assets a
            on a.workspace_id = s.workspace_id
           and a.file_id = s.file_id

          where s.workspace_id = ${workspaceId}

            and upper(
              coalesce(
                s.draw_code,
                ''
              )
            ) = ${drawCode}

          order by
            s.received_at asc,
            s.id asc

          limit 500
        `;

      } else {

        rows = await sql`
          select
            s.id,
            s.workspace_id,
            s.slip_id,
            s.file_id,
            s.source_filename,
            s.agent_code,
            s.draw_code,
            s.queue_status,
            s.assigned_subkey,
            s.received_at,
            s.claimed_at,
            s.completed_at,

            a.status as asset_status,
            a.mime_type,
            a.file_size_bytes,
            a.checksum_sha256

          from intake_slips s

          left join file_assets a
            on a.workspace_id = s.workspace_id
           and a.file_id = s.file_id

          where s.workspace_id = ${workspaceId}

          order by
            s.received_at asc,
            s.id asc

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
              row.completed_at,

            assetStatus:
              row.asset_status || '',

            mimeType:
              row.mime_type || '',

            fileSizeBytes:
              row.file_size_bytes === null
                ? null
                : Number(
                    row.file_size_bytes
                  ),

            checksumSha256:
              row.checksum_sha256 || ''
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

    if (
      error?.code === '23505'
    ) {
      return res.status(409).json({
        ok: false,
        message:
          'Slip ID หรือ File ID ซ้ำ กรุณาลองรับรูปอีกครั้ง'
      });
    }

    return res.status(500).json({
      ok: false,
      message:
        'ระบบรับรูปเกิดข้อผิดพลาด'
    });
  }
}
