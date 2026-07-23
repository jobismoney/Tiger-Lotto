import { put } from '@vercel/blob';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const MAX_UPLOAD_BYTES =
  15 * 1024 * 1024;

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function safeFilename(value) {
  const raw =
    clean(value) || 'image.jpg';

  return raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
}

async function readRawBody(req) {

  const chunks = [];
  let total = 0;

  for await (
    const chunk of req
  ) {

    total +=
      chunk.length;

    if (
      total >
      MAX_UPLOAD_BYTES
    ) {

      const error =
        new Error(
          'UPLOAD_TOO_LARGE'
        );

      error.code =
        'UPLOAD_TOO_LARGE';

      throw error;
    }

    chunks.push(
      Buffer.from(chunk)
    );
  }

  return Buffer.concat(
    chunks
  );
}

export default async function handler(
  req,
  res
) {

  try {

    // =========================================================
    // POST ONLY
    // =========================================================

    if (
      req.method !==
      'POST'
    ) {

      return res
        .status(405)
        .json({
          ok: false,
          message:
            'Method not allowed'
        });
    }


    // =========================================================
    // INPUT FROM QUERY
    //
    // Binary file อยู่ใน request body
    // metadata อยู่ใน query string
    // =========================================================

    const workspace =
      clean(
        req.query?.workspaceId
      );

    const requestId =
      clean(
        req.query?.requestId
      );

    const fileId =
      clean(
        req.query?.fileId
      );

    const bridgeCode =
      upper(
        req.query?.bridgeCode
      );

    const sourceFilename =
      safeFilename(
        req.query?.filename
      );


    if (!workspace) {

      return res
        .status(400)
        .json({
          ok: false,
          message:
            'ไม่พบ Workspace'
        });
    }


    if (!requestId) {

      return res
        .status(400)
        .json({
          ok: false,
          message:
            'ไม่พบ Request ID'
        });
    }


    if (!fileId) {

      return res
        .status(400)
        .json({
          ok: false,
          message:
            'ไม่พบ File ID'
        });
    }


    if (!bridgeCode) {

      return res
        .status(400)
        .json({
          ok: false,
          message:
            'ไม่พบ Bridge Code'
        });
    }


    // =========================================================
    // VERIFY RELAY REQUEST
    //
    // ต้องเป็น request ที่ Bridge นี้ claim ไว้จริง
    // และ fileId ต้องตรงกัน
    // =========================================================

    const requestRows =
      await sql`

        select
          id,
          request_id,
          workspace_id,
          draw_code,
          file_id,
          requester_type,
          requester_code,
          status,
          bridge_code,
          expires_at

        from bridge_relay_requests

        where request_id =
          ${requestId}

          and workspace_id =
            ${workspace}

        limit 1

      `;


    if (
      !requestRows.length
    ) {

      return res
        .status(404)
        .json({
          ok: false,
          message:
            'ไม่พบ Relay Request'
        });
    }


    const relayRequest =
      requestRows[0];


    if (
      relayRequest.file_id !==
      fileId
    ) {

      return res
        .status(409)
        .json({
          ok: false,
          message:
            'File ID ไม่ตรงกับ Relay Request'
        });
    }


    if (
      upper(
        relayRequest.bridge_code
      ) !==
      bridgeCode
    ) {

      return res
        .status(403)
        .json({
          ok: false,
          message:
            'Bridge นี้ไม่ได้ถือ Relay Request นี้'
        });
    }


    if (
      ![
        'CLAIMED',
        'TRANSFERRING'
      ].includes(
        relayRequest.status
      )
    ) {

      return res
        .status(409)
        .json({
          ok: false,
          message:
            'Relay Request ไม่อยู่ในสถานะที่อัปโหลดได้'
        });
    }


    if (
      new Date(
        relayRequest.expires_at
      ) <=
      new Date()
    ) {

      return res
        .status(410)
        .json({
          ok: false,
          message:
            'Relay Request หมดอายุแล้ว'
        });
    }


    // =========================================================
    // VERIFY FILE ASSET
    // =========================================================

    const assetRows =
      await sql`

        select
          file_id,
          source_filename,
          status

        from file_assets

        where workspace_id =
          ${workspace}

          and file_id =
            ${fileId}

        limit 1

      `;


    if (
      !assetRows.length
    ) {

      return res
        .status(404)
        .json({
          ok: false,
          message:
            'ไม่พบ File Asset'
        });
    }


    if (
      assetRows[0].status !==
      'AVAILABLE'
    ) {

      return res
        .status(403)
        .json({
          ok: false,
          message:
            'File Asset ไม่พร้อมใช้งาน'
        });
    }


    // =========================================================
    // MARK TRANSFERRING
    // =========================================================

    await sql`

      update bridge_relay_requests

      set
        status =
          'TRANSFERRING',

        updated_at =
          now()

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

        and bridge_code =
          ${bridgeCode}

    `;


    // =========================================================
    // READ BINARY BODY
    // =========================================================

    const fileBuffer =
      await readRawBody(
        req
      );


    if (
      !fileBuffer.length
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          message:
            'ไม่พบข้อมูลไฟล์'
        });
    }


    // =========================================================
    // CONTENT TYPE
    // =========================================================

    const contentType =
      clean(
        req.headers[
          'content-type'
        ]
      ) ||
      'application/octet-stream';


    // =========================================================
    // PRIVATE BLOB PATH
    //
    // ไม่ใช้ filename เป็น identity
    // identity หลักยังเป็น requestId + fileId
    // =========================================================

    const pathname =
      [
        'relay',
        workspace,
        relayRequest.draw_code,
        requestId,
        fileId,
        sourceFilename
      ]
        .map(
          part =>
            String(part)
              .replace(
                /[^a-zA-Z0-9._-]/g,
                '_'
              )
        )
        .join('/');


    // =========================================================
    // UPLOAD TO PRIVATE BLOB
    // =========================================================

    const blob =
      await put(
        pathname,
        fileBuffer,
        {
          access:
            'private',

          contentType,

          addRandomSuffix:
            false,

          cacheControlMaxAge:
            60
        }
      );


    // =========================================================
    // SAVE RELAY PAYLOAD INFO
    //
    // ต้องมี columns ที่เราจะเพิ่มใน Neon:
    // relay_blob_url
    // relay_blob_pathname
    // relay_file_size_bytes
    // relay_content_type
    // =========================================================

    const completedRows =
      await sql`

        update bridge_relay_requests

        set
          status =
            'READY',

          relay_blob_url =
            ${blob.url},

          relay_blob_pathname =
            ${blob.pathname},

          relay_file_size_bytes =
            ${fileBuffer.length},

          relay_content_type =
            ${contentType},

          updated_at =
            now()

        where request_id =
          ${requestId}

          and workspace_id =
            ${workspace}

          and bridge_code =
            ${bridgeCode}

        returning *

      `;


    if (
      !completedRows.length
    ) {

      return res
        .status(409)
        .json({
          ok: false,
          message:
            'อัปโหลดไฟล์แล้ว แต่บันทึก Relay Request ไม่สำเร็จ'
        });
    }


    return res
      .status(200)
      .json({

        ok: true,

        message:
          'Bridge อัปโหลดไฟล์เข้า Private Relay สำเร็จ',

        requestId,

        fileId,

        status:
          'READY',

        blob: {

          pathname:
            blob.pathname,

          sizeBytes:
            fileBuffer.length,

          contentType

        }
      });


  } catch (error) {

    console.error(
      'relay-upload error:',
      error
    );


    if (
      error?.code ===
      'UPLOAD_TOO_LARGE'
    ) {

      return res
        .status(413)
        .json({
          ok: false,
          message:
            'ไฟล์ใหญ่เกินขนาดที่ Relay รุ่นทดสอบรองรับ'
        });
    }


    return res
      .status(500)
      .json({
        ok: false,
        message:
          'ระบบ Relay Upload เกิดข้อผิดพลาด'
      });
  }
}

export const config = {
  api: {
    bodyParser: false
  }
};
