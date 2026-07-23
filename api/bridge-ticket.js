import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const TICKET_TTL_SECONDS = 60;

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function base64urlEncode(value) {
  return Buffer
    .from(value)
    .toString('base64url');
}

function signPayload(payloadBase64, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(payloadBase64)
    .digest('base64url');
}

export default async function handler(req, res) {
  try {

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        message: 'Method not allowed'
      });
    }

    const {
      workspaceId,
      drawCode,
      fileId,
      holderType,
      holderCode
    } = req.body || {};

    const workspace =
      clean(workspaceId);

    const draw =
      upper(drawCode);

    const file =
      clean(fileId);

    const holderTypeNormalized =
      upper(holderType);

    const holderCodeNormalized =
      upper(holderCode);


    // =========================================================
    // BASIC VALIDATION
    // =========================================================

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

    if (!holderTypeNormalized) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบ Holder Type'
      });
    }


    // =========================================================
    // SECRET
    //
    // ห้าม hardcode secret ลง GitHub
    // ต้องอยู่ใน Vercel Environment Variable เท่านั้น
    // =========================================================

    const ticketSecret =
      process.env.T999_BRIDGE_TICKET_SECRET;

    if (!ticketSecret) {
      return res.status(500).json({
        ok: false,
        message:
          'Bridge Ticket Secret ยังไม่ได้ตั้งค่า'
      });
    }


    // =========================================================
    // VERIFY WORKSPACE / TRIAL
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


    // =========================================================
    // VERIFY DRAW
    // =========================================================

    const drawRows = await sql`
      select
        id,
        draw_code,
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


    // =========================================================
    // VERIFY FILE ASSET
    //
    // ต้องมี file_id จริง
    // และอยู่ใน Workspace + Draw เดียวกันเท่านั้น
    // =========================================================

    const assetRows = await sql`
      select
        id,
        workspace_id,
        draw_code,
        file_id,
        source_filename,
        origin_role,
        origin_location,
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

    if (
      asset.status !==
      'AVAILABLE'
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'File Asset นี้ไม่พร้อมใช้งาน'
      });
    }


    // =========================================================
    // OPTIONAL PROTOTYPE CHECK:
    //
    // ถ้า Holder เป็น S
    // ตรวจว่า S นี้ถือ slip ที่ใช้ file_id นี้อยู่จริง
    //
    // ตอน Production ต้องเปลี่ยนเป็น Session/Role
    // ที่ Server เป็นคน derive เอง
    // ไม่เชื่อ holderCode จาก client
    // =========================================================

    if (
      holderTypeNormalized ===
      'S'
    ) {

      if (!holderCodeNormalized) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบรหัส Subkey'
        });
      }

      const slipRows = await sql`
        select
          id,
          slip_id,
          queue_status,
          assigned_subkey

        from intake_slips

        where workspace_id = ${workspace}

          and upper(
            coalesce(
              draw_code,
              ''
            )
          ) = ${draw}

          and file_id = ${file}

          and queue_status =
            'IN_PROGRESS'

          and upper(
            coalesce(
              assigned_subkey,
              ''
            )
          ) = ${holderCodeNormalized}

        limit 1
      `;

      if (!slipRows.length) {
        return res.status(403).json({
          ok: false,
          message:
            'Subkey นี้ไม่มีสิทธิ์เข้าถึงไฟล์นี้ในสถานะปัจจุบัน'
        });
      }
    }


    // =========================================================
    // CREATE SHORT-LIVED TICKET
    // =========================================================

    const issuedAt =
      Math.floor(
        Date.now() / 1000
      );

    const expiresAt =
      issuedAt +
      TICKET_TTL_SECONDS;

    const nonce =
      crypto
        .randomBytes(16)
        .toString('hex');

    const payload = {
      v: 1,

      workspaceId:
        workspace,

      drawCode:
        draw,

      fileId:
        file,

      holderType:
        holderTypeNormalized,

      holderCode:
        holderCodeNormalized || '',

      iat:
        issuedAt,

      exp:
        expiresAt,

      nonce
    };

    const payloadJson =
      JSON.stringify(payload);

    const payloadBase64 =
      base64urlEncode(
        payloadJson
      );

    const signature =
      signPayload(
        payloadBase64,
        ticketSecret
      );

    const ticket =
      payloadBase64 +
      '.' +
      signature;


    // =========================================================
    // RESPONSE
    // =========================================================

    return res.status(200).json({
      ok: true,

      message:
        'ออก Bridge Ticket สำเร็จ',

      ticket,

      expiresInSeconds:
        TICKET_TTL_SECONDS,

      expiresAt:
        new Date(
          expiresAt * 1000
        ).toISOString(),

      asset: {
        workspaceId:
          asset.workspace_id,

        drawCode:
          asset.draw_code,

        fileId:
          asset.file_id,

        sourceFilename:
          asset.source_filename,

        originRole:
          asset.origin_role,

        originLocation:
          asset.origin_location || ''
      }
    });

  } catch (error) {

    console.error(
      'bridge-ticket error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Bridge Ticket เกิดข้อผิดพลาด'
    });
  }
}
