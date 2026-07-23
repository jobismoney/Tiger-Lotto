import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
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
    // POST ONLY
    // =========================================================

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        message: 'Method not allowed'
      });
    }

    const {
      action,
      workspaceId,
      bridgeCode,
      requestId
    } = req.body || {};

    const command =
      upper(action);

    const workspace =
      clean(workspaceId);

    const bridge =
      upper(bridgeCode);

    const targetRequestId =
      clean(requestId);


    if (!workspace) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Workspace'
      });
    }

    if (!bridge) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Bridge Code'
      });
    }


    // =========================================================
    // VERIFY WORKSPACE
    // =========================================================

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


    // =========================================================
    // CLAIM_NEXT
    //
    // Bridge ฝั่ง R โทรออกมาหา Cloud
    // แล้วรับ request WAITING ใบแรก
    // =========================================================

    if (command === 'CLAIM_NEXT') {

      const claimedRows = await sql`
        with next_request as (

          select
            id

          from bridge_relay_requests

          where workspace_id = ${workspace}

            and status = 'WAITING'

            and expires_at > now()

          order by
            created_at asc,
            id asc

          for update
          skip locked

          limit 1
        )

        update bridge_relay_requests

        set
          status = 'CLAIMED',
          bridge_code = ${bridge},
          claimed_at = now(),
          updated_at = now()

        where id = (
          select id
          from next_request
        )

          and status = 'WAITING'

        returning *
      `;

      if (!claimedRows.length) {

        return res.status(200).json({
          ok: true,
          empty: true,
          message:
            'ไม่มี Relay Request ที่รอ Bridge'
        });
      }

      const claimed =
        claimedRows[0];


      // -------------------------------------------------------
      // อ่าน metadata ของไฟล์
      // -------------------------------------------------------

      const assetRows = await sql`
        select
          file_id,
          source_filename,
          draw_code,
          origin_role,
          origin_location,
          mime_type,
          file_size_bytes,
          checksum_sha256,
          status

        from file_assets

        where workspace_id = ${workspace}

          and file_id = ${claimed.file_id}

        limit 1
      `;

      if (!assetRows.length) {

        await sql`
          update bridge_relay_requests

          set
            status = 'FAILED',
            updated_at = now()

          where request_id =
            ${claimed.request_id}
        `;

        return res.status(409).json({
          ok: false,
          message:
            'พบ Relay Request แต่ไม่พบ File Asset'
        });
      }

      const asset =
        assetRows[0];

      if (asset.status !== 'AVAILABLE') {

        await sql`
          update bridge_relay_requests

          set
            status = 'FAILED',
            updated_at = now()

          where request_id =
            ${claimed.request_id}
        `;

        return res.status(409).json({
          ok: false,
          message:
            'File Asset นี้ไม่พร้อมใช้งาน'
        });
      }


      return res.status(200).json({
        ok: true,
        empty: false,
        message:
          'Bridge รับ Relay Request สำเร็จ',

        request:
          mapRequest(claimed),

        asset: {
          fileId:
            asset.file_id,

          sourceFilename:
            asset.source_filename,

          drawCode:
            asset.draw_code,

          originRole:
            asset.origin_role,

          originLocation:
            asset.origin_location || '',

          mimeType:
            asset.mime_type || '',

          fileSizeBytes:
            asset.file_size_bytes || null,

          checksumSha256:
            asset.checksum_sha256 || ''
        }
      });
    }


    // =========================================================
    // MARK_TRANSFERRING
    //
    // Bridge พบไฟล์จริงแล้วและกำลังเริ่มส่ง
    // =========================================================

    if (command === 'MARK_TRANSFERRING') {

      if (!targetRequestId) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบ Request ID'
        });
      }

      const rows = await sql`
        update bridge_relay_requests

        set
          status = 'TRANSFERRING',
          updated_at = now()

        where request_id =
          ${targetRequestId}

          and workspace_id =
            ${workspace}

          and bridge_code =
            ${bridge}

          and status =
            'CLAIMED'

          and expires_at > now()

        returning *
      `;

      if (!rows.length) {
        return res.status(409).json({
          ok: false,
          message:
            'ไม่สามารถเปลี่ยนสถานะเป็น TRANSFERRING ได้'
        });
      }

      return res.status(200).json({
        ok: true,
        message:
          'Relay Request อยู่ในสถานะ TRANSFERRING แล้ว',
        request:
          mapRequest(rows[0])
      });
    }


    // =========================================================
    // COMPLETE
    //
    // ตอนนี้ใช้หลังส่งไฟล์สำเร็จ
    // binary upload endpoint จะทำแยกอีกไฟล์
    // =========================================================

    if (command === 'COMPLETE') {

      if (!targetRequestId) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบ Request ID'
        });
      }

      const rows = await sql`
        update bridge_relay_requests

        set
          status = 'COMPLETED',
          completed_at = now(),
          updated_at = now()

        where request_id =
          ${targetRequestId}

          and workspace_id =
            ${workspace}

          and bridge_code =
            ${bridge}

          and status in (
            'CLAIMED',
            'TRANSFERRING'
          )

        returning *
      `;

      if (!rows.length) {
        return res.status(409).json({
          ok: false,
          message:
            'ไม่สามารถ Complete Relay Request นี้ได้'
        });
      }

      return res.status(200).json({
        ok: true,
        message:
          'Relay Request เสร็จสมบูรณ์',
        request:
          mapRequest(rows[0])
      });
    }


    // =========================================================
    // RELEASE
    //
    // Bridge รับแล้วแต่ยังส่งไม่ได้
    // คืนกลับ WAITING ให้ Bridge ตัวอื่น/รอบถัดไปรับ
    // =========================================================

    if (command === 'RELEASE') {

      if (!targetRequestId) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบ Request ID'
        });
      }

      const rows = await sql`
        update bridge_relay_requests

        set
          status = 'WAITING',
          bridge_code = null,
          claimed_at = null,
          updated_at = now()

        where request_id =
          ${targetRequestId}

          and workspace_id =
            ${workspace}

          and bridge_code =
            ${bridge}

          and status in (
            'CLAIMED',
            'TRANSFERRING'
          )

          and expires_at > now()

        returning *
      `;

      if (!rows.length) {
        return res.status(409).json({
          ok: false,
          message:
            'ไม่สามารถคืน Relay Request นี้ได้'
        });
      }

      return res.status(200).json({
        ok: true,
        message:
          'คืน Relay Request กลับ WAITING แล้ว',
        request:
          mapRequest(rows[0])
      });
    }


    return res.status(400).json({
      ok: false,
      message:
        'Action ไม่ถูกต้อง'
    });

  } catch (error) {

    console.error(
      'relay-bridge error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Relay Bridge เกิดข้อผิดพลาด'
    });
  }
}
