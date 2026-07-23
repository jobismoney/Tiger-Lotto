import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function makeRequestId() {
  return (
    'REQ-' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    crypto.randomBytes(5).toString('hex').toUpperCase()
  );
}

function mapRequest(row) {
  return {
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    drawCode: row.draw_code,
    fileId: row.file_id,
    requesterType: row.requester_type,
    requesterCode: row.requester_code || '',
    status: row.status,
    bridgeCode: row.bridge_code || '',
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at
  };
}

export default async function handler(req, res) {
  try {

    // =========================================================
    // POST
    //
    // CREATE_REQUEST
    // S/M ขอไฟล์จาก Bridge ฝั่ง R
    // =========================================================

    if (req.method === 'POST') {

      const {
        action,
        workspaceId,
        drawCode,
        fileId,
        requesterType,
        requesterCode
      } = req.body || {};

      const command =
        upper(action);

      const workspace =
        clean(workspaceId);

      const draw =
        upper(drawCode);

      const file =
        clean(fileId);

      const reqType =
        upper(requesterType);

      const reqCode =
        upper(requesterCode);


      if (command !== 'CREATE_REQUEST') {
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

      if (!draw) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบงวด'
        });
      }

      if (!file) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ File ID'
        });
      }

      if (!reqType) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Requester Type'
        });
      }


      // =======================================================
      // VERIFY WORKSPACE
      // =======================================================

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
          message: 'ไม่พบ Workspace'
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
      // VERIFY DRAW
      // =======================================================

      const drawRows = await sql`
        select
          id,
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


      // =======================================================
      // VERIFY FILE
      // =======================================================

      const assetRows = await sql`
        select
          id,
          file_id,
          source_filename,
          status

        from file_assets

        where workspace_id = ${workspace}

          and upper(draw_code) = ${draw}

          and file_id = ${file}

        limit 1
      `;

      if (!assetRows.length) {
        return res.status(404).json({
          ok: false,
          message:
            'ไม่พบ File Asset นี้ใน Workspace/งวด'
        });
      }

      const asset =
        assetRows[0];

      if (asset.status !== 'AVAILABLE') {
        return res.status(403).json({
          ok: false,
          message:
            'File Asset นี้ไม่พร้อมใช้งาน'
        });
      }


      // =======================================================
      // PROTOTYPE REQUESTER CHECK
      //
      // ถ้า requester เป็น S
      // ต้องถือ slip นี้อยู่จริง
      //
      // Production:
      // ต้อง derive จาก Server Session
      // =======================================================

      if (reqType === 'S') {

        if (!reqCode) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบรหัส Subkey'
          });
        }

        const holderRows = await sql`
          select
            id

          from intake_slips

          where workspace_id = ${workspace}

            and upper(
              coalesce(
                draw_code,
                ''
              )
            ) = ${draw}

            and file_id = ${file}

            and queue_status = 'IN_PROGRESS'

            and upper(
              coalesce(
                assigned_subkey,
                ''
              )
            ) = ${reqCode}

          limit 1
        `;

        if (!holderRows.length) {
          return res.status(403).json({
            ok: false,
            message:
              'Subkey นี้ไม่มีสิทธิ์ขอไฟล์นี้'
          });
        }
      }


      // =======================================================
      // REUSE EXISTING OPEN REQUEST
      //
      // ป้องกันกดซ้ำแล้วสร้าง request รัว ๆ
      // =======================================================

      const existingRows = await sql`
        select
          *

        from bridge_relay_requests

        where workspace_id = ${workspace}

          and draw_code = ${draw}

          and file_id = ${file}

          and requester_type = ${reqType}

          and coalesce(
            requester_code,
            ''
          ) = ${reqCode}

          and status in (
            'WAITING',
            'CLAIMED',
            'TRANSFERRING'
          )

          and expires_at > now()

        order by
          created_at desc

        limit 1
      `;

      if (existingRows.length) {

        return res.status(200).json({
          ok: true,
          reused: true,
          message:
            'พบ Relay Request เดิมที่ยังใช้งานอยู่',
          request:
            mapRequest(existingRows[0])
        });
      }


      // =======================================================
      // CREATE REQUEST
      //
      // อายุ 5 นาทีสำหรับ prototype
      // Bridge ต้องมา claim ก่อนหมดอายุ
      // =======================================================

      const requestId =
        makeRequestId();

      const createdRows = await sql`
        insert into bridge_relay_requests (
          request_id,
          workspace_id,
          draw_code,
          file_id,
          requester_type,
          requester_code,
          status,
          created_at,
          updated_at,
          expires_at
        )

        values (
          ${requestId},
          ${workspace},
          ${draw},
          ${file},
          ${reqType},
          ${reqCode || null},
          'WAITING',
          now(),
          now(),
          now() + interval '5 minutes'
        )

        returning *
      `;


      return res.status(201).json({
        ok: true,
        reused: false,
        message:
          'สร้าง Relay Request สำเร็จ',
        asset: {
          fileId:
            asset.file_id,
          sourceFilename:
            asset.source_filename
        },
        request:
          mapRequest(createdRows[0])
      });
    }


    // =========================================================
    // GET
    //
    // ตอนนี้ใช้ตรวจสถานะ request
    //
    // Bridge polling endpoint
    // จะทำแยกอีกไฟล์เพื่อบังคับ auth/device scope ชัดเจน
    // =========================================================

    if (req.method === 'GET') {

      const requestId =
        clean(req.query?.requestId);

      if (!requestId) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบ Request ID'
        });
      }


      const rows = await sql`
        select
          *

        from bridge_relay_requests

        where request_id = ${requestId}

        limit 1
      `;


      if (!rows.length) {
        return res.status(404).json({
          ok: false,
          message:
            'ไม่พบ Relay Request นี้'
        });
      }


      return res.status(200).json({
        ok: true,
        request:
          mapRequest(rows[0])
      });
    }


    return res.status(405).json({
      ok: false,
      message:
        'Method not allowed'
    });

  } catch (error) {

    console.error(
      'relay-request error:',
      error
    );


    // ถ้ายังไม่ได้สร้าง table
    if (
      error?.code ===
      '42P01'
    ) {

      return res.status(500).json({
        ok: false,
        code:
          'RELAY_TABLE_MISSING',
        message:
          'ยังไม่ได้สร้างตาราง bridge_relay_requests'
      });
    }


    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Relay Request เกิดข้อผิดพลาด'
    });
  }
}
