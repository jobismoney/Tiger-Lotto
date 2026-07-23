import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeBaseUrl(value) {
  const raw = clean(value);

  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);

    if (
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:'
    ) {
      return '';
    }

    return parsed
      .toString()
      .replace(/\/+$/, '');

  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  try {

    // =========================================================
    // METHOD
    // =========================================================

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        message: 'Method not allowed'
      });
    }


    // =========================================================
    // INPUT
    // =========================================================

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
    // VERIFY DRAW
    // =========================================================

    const drawRows = await sql`
      select
        id,
        draw_code,
        market_code,
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

    if (asset.status !== 'AVAILABLE') {
      return res.status(403).json({
        ok: false,
        message:
          'File Asset นี้ไม่พร้อมใช้งาน'
      });
    }


    // =========================================================
    // PROTOTYPE HOLDER CHECK
    //
    // ถ้าเป็น S:
    // ต้องถือ slip นี้อยู่จริง
    //
    // Production:
    // ต้อง derive Role/Workspace จาก Server Session
    // ห้ามเชื่อ holderCode จาก client
    // =========================================================

    if (
      holderTypeNormalized === 'S'
    ) {

      if (!holderCodeNormalized) {
        return res.status(400).json({
          ok: false,
          message:
            'ไม่พบรหัส Subkey'
        });
      }

      const holderRows = await sql`
        select
          id,
          slip_id,
          file_id,
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

      if (!holderRows.length) {
        return res.status(403).json({
          ok: false,
          message:
            'Subkey นี้ไม่มีสิทธิ์เข้าถึงไฟล์นี้'
        });
      }
    }


    // =========================================================
    // ROUTE CONFIG
    //
    // Local Bridge:
    // Browser/Runtime จะตรวจเองว่าเข้าถึงได้หรือไม่
    //
    // Relay A / B:
    // ตั้งผ่าน Vercel Environment Variables
    //
    // ห้าม hardcode provider เข้า protocol หลัก
    // =========================================================

    const primaryRelay =
      normalizeBaseUrl(
        process.env.T999_PRIMARY_RELAY_URL
      );

    const secondaryRelay =
      normalizeBaseUrl(
        process.env.T999_SECONDARY_RELAY_URL
      );


    // =========================================================
    // SMART PATH POLICY V1
    //
    // priority ต่ำกว่า = ลองก่อน
    //
    // ตอนนี้ยังไม่ถือว่า health-tested
    // Client/Runtime ต้อง probe ก่อนใช้งาน
    // =========================================================

    const routes = [

      {
        id: 'LOCAL_BRIDGE',

        type: 'LOCAL',

        priority: 10,

        enabled: true,

        probeUrl:
          'http://127.0.0.1:8787/health',

        transport:
          'HTTP_LOCAL',

        purpose:
          'ใช้เมื่อ Bridge อยู่เครื่องเดียวกันหรือ Runtime เข้าถึง Local Bridge ได้',

        health:
          'UNKNOWN'
      },

      {
        id: 'PRIMARY_RELAY',

        type: 'RELAY',

        priority: 20,

        enabled:
          Boolean(primaryRelay),

        baseUrl:
          primaryRelay || null,

        transport:
          'HTTPS_443',

        purpose:
          'เส้นทางหลักสำหรับ R/S คนละสถานที่',

        health:
          'UNKNOWN'
      },

      {
        id: 'SECONDARY_RELAY',

        type: 'RELAY',

        priority: 30,

        enabled:
          Boolean(secondaryRelay),

        baseUrl:
          secondaryRelay || null,

        transport:
          'HTTPS_443',

        purpose:
          'เส้นทางสำรองเมื่อ Primary Relay ใช้งานไม่ได้',

        health:
          'UNKNOWN'
      },

      {
        id: 'STORE_AND_FORWARD',

        type: 'RETRY_QUEUE',

        priority: 40,

        enabled: true,

        transport:
          'DEFERRED',

        purpose:
          'ค้างคำขอและ retry เมื่อทุกเส้นทางชั่วคราวใช้ไม่ได้',

        health:
          'READY'
      }

    ];


    // =========================================================
    // FILTER / SORT
    // =========================================================

    const enabledRoutes =
      routes
        .filter(
          route =>
            route.enabled
        )
        .sort(
          (a, b) =>
            a.priority -
            b.priority
        );


    // =========================================================
    // RESPONSE
    // =========================================================

    return res.status(200).json({

      ok: true,

      message:
        'สร้าง Smart Path Plan สำเร็จ',

      policy: {

        strategy:
          'FASTEST_AVAILABLE_WITH_FAILOVER',

        preferredOrder: [
          'LOCAL_BRIDGE',
          'PRIMARY_RELAY',
          'SECONDARY_RELAY',
          'STORE_AND_FORWARD'
        ],

        probeBeforeUse:
          true,

        automaticFailover:
          true,

        retryEnabled:
          true
      },

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
      },

      requester: {

        holderType:
          holderTypeNormalized,

        holderCode:
          holderCodeNormalized || ''
      },

      routes:
        enabledRoutes,

      configured: {

        localBridge:
          true,

        primaryRelay:
          Boolean(primaryRelay),

        secondaryRelay:
          Boolean(secondaryRelay),

        storeAndForward:
          true
      },

      generatedAt:
        new Date().toISOString()
    });

  } catch (error) {

    console.error(
      'bridge-route error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Smart Path Controller เกิดข้อผิดพลาด'
    });
  }
}
