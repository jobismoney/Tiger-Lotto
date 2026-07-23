import { get } from '@vercel/blob';
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

    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        message: 'Method not allowed'
      });
    }

    const workspace =
      clean(req.query?.workspaceId);

    const requestId =
      clean(req.query?.requestId);

    const requesterType =
      upper(req.query?.requesterType);

    const requesterCode =
      upper(req.query?.requesterCode);


    if (!workspace) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Workspace'
      });
    }

    if (!requestId) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Request ID'
      });
    }

    if (!requesterType) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Requester Type'
      });
    }


    // =========================================================
    // VERIFY RELAY REQUEST
    // =========================================================

    const rows = await sql`
      select
        request_id,
        workspace_id,
        draw_code,
        file_id,
        requester_type,
        requester_code,
        status,
        relay_blob_url,
        relay_blob_pathname,
        relay_file_size_bytes,
        relay_content_type,
        expires_at

      from bridge_relay_requests

      where request_id = ${requestId}

        and workspace_id = ${workspace}

      limit 1
    `;

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'ไม่พบ Relay Request นี้'
      });
    }

    const relay =
      rows[0];


    if (relay.status !== 'READY') {
      return res.status(409).json({
        ok: false,
        message:
          'Relay Request ยังไม่พร้อมดาวน์โหลด'
      });
    }


    if (!relay.relay_blob_pathname) {
      return res.status(409).json({
        ok: false,
        message:
          'ไม่พบข้อมูลไฟล์ Relay'
      });
    }


    // =========================================================
    // PROTOTYPE REQUESTER CHECK
    //
    // Production ต้อง derive จาก server session
    // ห้ามเชื่อ requesterCode จาก client
    // =========================================================

    if (
      upper(relay.requester_type) !==
      requesterType
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'Requester Type ไม่ตรงกับ Relay Request'
      });
    }


    if (requesterType === 'S') {

      if (!requesterCode) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบรหัส Subkey'
        });
      }

      if (
        upper(
          relay.requester_code
        ) !== requesterCode
      ) {
        return res.status(403).json({
          ok: false,
          message:
            'Subkey นี้ไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้'
        });
      }


      // ตรวจซ้ำว่า S ยังถือ slip นี้อยู่จริง
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
          ) = ${upper(
            relay.draw_code
          )}

          and file_id =
            ${relay.file_id}

          and queue_status =
            'IN_PROGRESS'

          and upper(
            coalesce(
              assigned_subkey,
              ''
            )
          ) = ${requesterCode}

        limit 1
      `;

      if (!holderRows.length) {
        return res.status(403).json({
          ok: false,
          message:
            'Subkey นี้ไม่ได้ถือโพยนี้อยู่แล้ว'
        });
      }
    }


    // =========================================================
    // READ PRIVATE BLOB
    // =========================================================

    const result =
      await get(
        relay.relay_blob_pathname,
        {
          access: 'private'
        }
      );


    if (!result) {
      return res.status(404).json({
        ok: false,
        message:
          'ไม่พบไฟล์ใน Private Relay'
      });
    }


    // =========================================================
    // STREAM BACK TO S
    // =========================================================

    const contentType =
      relay.relay_content_type ||
      'application/octet-stream';


    res.setHeader(
      'Content-Type',
      contentType
    );

    res.setHeader(
      'Cache-Control',
      'private, no-store'
    );

    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    );

    res.setHeader(
      'Content-Length',
      String(
        relay.relay_file_size_bytes ||
        ''
      )
    );


    const reader =
      result.stream.getReader();


    while (true) {

      const {
        done,
        value
      } =
        await reader.read();


      if (done) {
        break;
      }

      res.write(
        Buffer.from(
          value
        )
      );
    }


    res.end();

  } catch (error) {

    console.error(
      'relay-download error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Relay Download เกิดข้อผิดพลาด'
    });
  }
}
