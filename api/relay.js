import crypto from 'crypto';
import { Readable } from 'node:stream';
import { neon } from '@neondatabase/serverless';
import { put, get } from '@vercel/blob';

const sql = neon(process.env.DATABASE_URL);

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const REQUEST_TTL_MINUTES = 5;

// =========================================================
// HELPERS
// =========================================================

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

function safeFilename(value) {
  const raw = clean(value) || 'image.jpg';

  return raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
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
    expiresAt: row.expires_at,

    relayFileSizeBytes:
      row.relay_file_size_bytes || null,

    relayContentType:
      row.relay_content_type || ''
  };
}

async function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > maxBytes) {
      const error = new Error('UPLOAD_TOO_LARGE');
      error.code = 'UPLOAD_TOO_LARGE';
      throw error;
    }

    chunks.push(
      Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buffer =
    await readRawBody(
      req,
      1024 * 1024
    );

  if (!buffer.length) {
    return {};
  }

  try {
    return JSON.parse(
      buffer.toString('utf8')
    );
  } catch {
    const error =
      new Error('INVALID_JSON');

    error.code =
      'INVALID_JSON';

    throw error;
  }
}

async function verifyWorkspace(workspaceId) {
  const rows = await sql`
    select
      id,
      status,
      starts_at,
      expires_at

    from trial_access

    where workspace_id =
      ${workspaceId}

    limit 1
  `;

  if (!rows.length) {
    return {
      ok: false,
      status: 404,
      message:
        'ไม่พบ Workspace'
    };
  }

  const trial = rows[0];
  const now = new Date();

  if (trial.status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      message:
        'Workspace นี้ถูกปิดใช้งาน'
    };
  }

  if (
    now <
    new Date(trial.starts_at)
  ) {
    return {
      ok: false,
      status: 403,
      message:
        'Workspace นี้ยังไม่ถึงเวลาเริ่มใช้งาน'
    };
  }

  if (
    now >=
    new Date(trial.expires_at)
  ) {
    return {
      ok: false,
      status: 403,
      message:
        'Workspace นี้หมดอายุแล้ว'
    };
  }

  return {
    ok: true,
    trial
  };
}

async function verifyDraw(
  workspaceId,
  drawCode
) {
  const rows = await sql`
    select
      id,
      draw_code,
      status,
      opens_at,
      closes_at

    from workspace_draws

    where workspace_id =
      ${workspaceId}

      and upper(draw_code) =
        ${upper(drawCode)}

    limit 1
  `;

  if (!rows.length) {
    return {
      ok: false,
      status: 404,
      message:
        'ไม่พบงวดนี้'
    };
  }

  const draw = rows[0];
  const now = new Date();

  if (draw.status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      message:
        'งวดนี้ไม่ได้อยู่ในสถานะ ACTIVE'
    };
  }

  if (
    draw.opens_at &&
    now <
    new Date(draw.opens_at)
  ) {
    return {
      ok: false,
      status: 403,
      message:
        'งวดนี้ยังไม่ถึงเวลาเปิด'
    };
  }

  if (
    draw.closes_at &&
    now >=
    new Date(draw.closes_at)
  ) {
    return {
      ok: false,
      status: 403,
      message:
        'งวดนี้ถึงเวลาปิดแล้ว'
    };
  }

  return {
    ok: true,
    draw
  };
}

async function verifyAsset(
  workspaceId,
  drawCode,
  fileId
) {
  const rows = await sql`
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

    where workspace_id =
      ${workspaceId}

      and upper(draw_code) =
        ${upper(drawCode)}

      and file_id =
        ${fileId}

    limit 1
  `;

  if (!rows.length) {
    return {
      ok: false,
      status: 404,
      message:
        'ไม่พบ File Asset นี้'
    };
  }

  const asset = rows[0];

  if (asset.status !== 'AVAILABLE') {
    return {
      ok: false,
      status: 403,
      message:
        'File Asset นี้ไม่พร้อมใช้งาน'
    };
  }

  return {
    ok: true,
    asset
  };
}

async function verifySubkeyHolder({
  workspaceId,
  drawCode,
  fileId,
  subkeyCode
}) {
  const rows = await sql`
    select
      id

    from intake_slips

    where workspace_id =
      ${workspaceId}

      and upper(
        coalesce(
          draw_code,
          ''
        )
      ) =
        ${upper(drawCode)}

      and file_id =
        ${fileId}

      and queue_status =
        'IN_PROGRESS'

      and upper(
        coalesce(
          assigned_subkey,
          ''
        )
      ) =
        ${upper(subkeyCode)}

    limit 1
  `;

  return rows.length > 0;
}


// =========================================================
// PRE-STAGE PREVIEW
// =========================================================

async function claimPrestage(req, res, body) {
  const workspace = clean(body.workspaceId);
  const bridgeCode = upper(body.bridgeCode);

  if (!workspace || !bridgeCode) {
    return res.status(400).json({
      ok: false,
      message: 'Workspace หรือ Bridge Code ไม่ครบ'
    });
  }

  const workspaceCheck = await verifyWorkspace(workspace);

  if (!workspaceCheck.ok) {
    return res.status(workspaceCheck.status).json({
      ok: false,
      message: workspaceCheck.message
    });
  }

  const claimed = await sql`
    with next_asset as (
      select a.id
      from file_assets a
      inner join intake_slips s
        on s.workspace_id = a.workspace_id
       and s.file_id = a.file_id
      where a.workspace_id = ${workspace}
        and a.status = 'AVAILABLE'
        and coalesce(a.preview_status, 'NONE') in ('NONE', 'FAILED')
        and s.queue_status in ('WAITING', 'IN_PROGRESS')
      order by s.received_at asc, s.id asc
      for update of a skip locked
      limit 1
    )
    update file_assets
    set
      preview_status = 'UPLOADING',
      updated_at = now()
    where id = (select id from next_asset)
    returning
      workspace_id,
      draw_code,
      file_id,
      source_filename,
      mime_type,
      file_size_bytes,
      checksum_sha256,
      preview_status
  `;

  if (!claimed.length) {
    return res.status(200).json({
      ok: true,
      empty: true,
      message: 'ไม่มีไฟล์ที่ต้อง Pre-Stage'
    });
  }

  const asset = claimed[0];

  return res.status(200).json({
    ok: true,
    empty: false,
    message: 'Bridge รับงาน Pre-Stage สำเร็จ',
    bridgeCode,
    asset: {
      workspaceId: asset.workspace_id,
      drawCode: asset.draw_code,
      fileId: asset.file_id,
      sourceFilename: asset.source_filename,
      mimeType: asset.mime_type || '',
      fileSizeBytes: asset.file_size_bytes || null,
      checksumSha256: asset.checksum_sha256 || '',
      previewStatus: asset.preview_status
    }
  });
}

async function prestageUpload(req, res) {
  const workspace = clean(req.query?.workspaceId);
  const fileId = clean(req.query?.fileId);
  const bridgeCode = upper(req.query?.bridgeCode);
  const filename = safeFilename(req.query?.filename);

  if (!workspace || !fileId || !bridgeCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Pre-Stage Upload ไม่ครบ'
    });
  }

  const assetRows = await sql`
    select
      workspace_id,
      draw_code,
      file_id,
      status,
      preview_status
    from file_assets
    where workspace_id = ${workspace}
      and file_id = ${fileId}
    limit 1
  `;

  if (!assetRows.length) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบ File Asset'
    });
  }

  const asset = assetRows[0];

  if (asset.status !== 'AVAILABLE') {
    return res.status(409).json({
      ok: false,
      message: 'File Asset ไม่พร้อมใช้งาน'
    });
  }

  if (asset.preview_status === 'READY') {
    return res.status(200).json({
      ok: true,
      reused: true,
      message: 'Preview นี้ READY อยู่แล้ว'
    });
  }

  if (asset.preview_status !== 'UPLOADING') {
    return res.status(409).json({
      ok: false,
      message: 'File Asset ไม่ได้อยู่ในสถานะ UPLOADING'
    });
  }

  const fileBuffer = await readRawBody(req);

  if (!fileBuffer.length) {
    await sql`
      update file_assets
      set preview_status = 'FAILED', updated_at = now()
      where workspace_id = ${workspace}
        and file_id = ${fileId}
    `;

    return res.status(400).json({
      ok: false,
      message: 'ไม่พบข้อมูลไฟล์ Preview'
    });
  }

  const contentType =
    clean(req.headers['content-type']) ||
    'application/octet-stream';

  const pathname = [
    'prestage',
    workspace,
    asset.draw_code,
    fileId,
    filename
  ]
    .map(part =>
      String(part).replace(/[^a-zA-Z0-9._-]/g, '_')
    )
    .join('/');

  try {
    const blob = await put(pathname, fileBuffer, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      cacheControlMaxAge: 300
    });

    const ready = await sql`
      update file_assets
      set
        preview_status = 'READY',
        preview_blob_pathname = ${blob.pathname},
        preview_file_size_bytes = ${fileBuffer.length},
        preview_content_type = ${contentType},
        updated_at = now()
      where workspace_id = ${workspace}
        and file_id = ${fileId}
        and status = 'AVAILABLE'
      returning
        file_id,
        preview_status,
        preview_blob_pathname,
        preview_file_size_bytes,
        preview_content_type
    `;

    if (!ready.length) {
      return res.status(409).json({
        ok: false,
        message: 'Upload Preview สำเร็จ แต่บันทึกสถานะไม่สำเร็จ'
      });
    }

    return res.status(200).json({
      ok: true,
      reused: false,
      message: 'Pre-Stage Preview สำเร็จ',
      bridgeCode,
      asset: {
        fileId: ready[0].file_id,
        previewStatus: ready[0].preview_status,
        previewPathname: ready[0].preview_blob_pathname,
        previewFileSizeBytes: ready[0].preview_file_size_bytes,
        previewContentType: ready[0].preview_content_type
      }
    });
  } catch (error) {
    await sql`
      update file_assets
      set preview_status = 'FAILED', updated_at = now()
      where workspace_id = ${workspace}
        and file_id = ${fileId}
    `;
    throw error;
  }
}

async function previewStatus(req, res) {
  const workspace = clean(req.query?.workspaceId);
  const fileId = clean(req.query?.fileId);

  if (!workspace || !fileId) {
    return res.status(400).json({
      ok: false,
      message: 'Workspace หรือ File ID ไม่ครบ'
    });
  }

  const rows = await sql`
    select
      file_id,
      preview_status,
      preview_file_size_bytes,
      preview_content_type
    from file_assets
    where workspace_id = ${workspace}
      and file_id = ${fileId}
    limit 1
  `;

  if (!rows.length) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบ File Asset'
    });
  }

  const asset = rows[0];

  return res.status(200).json({
    ok: true,
    asset: {
      fileId: asset.file_id,
      previewStatus: asset.preview_status || 'NONE',
      previewFileSizeBytes: asset.preview_file_size_bytes || null,
      previewContentType: asset.preview_content_type || ''
    }
  });
}

async function previewDownload(req, res) {
  const workspace = clean(req.query?.workspaceId);
  const fileId = clean(req.query?.fileId);
  const requesterType = upper(req.query?.requesterType);
  const requesterCode = upper(req.query?.requesterCode);

  if (!workspace || !fileId || !requesterType) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Preview Download ไม่ครบ'
    });
  }

  const rows = await sql`
    select
      workspace_id,
      draw_code,
      file_id,
      status,
      preview_status,
      preview_blob_pathname,
      preview_file_size_bytes,
      preview_content_type
    from file_assets
    where workspace_id = ${workspace}
      and file_id = ${fileId}
    limit 1
  `;

  if (!rows.length) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบ File Asset'
    });
  }

  const asset = rows[0];

  if (asset.status !== 'AVAILABLE') {
    return res.status(409).json({
      ok: false,
      message: 'File Asset ไม่พร้อมใช้งาน'
    });
  }

  if (
    asset.preview_status !== 'READY' ||
    !asset.preview_blob_pathname
  ) {
    return res.status(409).json({
      ok: false,
      message: 'Preview ยังไม่พร้อม'
    });
  }

  if (requesterType === 'S') {
    if (!requesterCode) {
      return res.status(400).json({
        ok: false,
        message: 'ไม่พบรหัส Subkey'
      });
    }

    const allowed = await verifySubkeyHolder({
      workspaceId: workspace,
      drawCode: asset.draw_code,
      fileId: asset.file_id,
      subkeyCode: requesterCode
    });

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        message: 'Subkey นี้ไม่มีสิทธิ์ Download Preview นี้'
      });
    }
  }

  const result = await get(asset.preview_blob_pathname, {
    access: 'private'
  });

  if (!result) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบ Preview ใน Private Blob'
    });
  }

  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    asset.preview_content_type ||
      result.blob?.contentType ||
      'application/octet-stream'
  );
  res.setHeader(
    'Cache-Control',
    'private, max-age=60'
  );
  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  if (asset.preview_file_size_bytes) {
    res.setHeader(
      'Content-Length',
      String(asset.preview_file_size_bytes)
    );
  }

  const nodeStream = Readable.fromWeb(result.stream);

  await new Promise((resolve, reject) => {
    nodeStream.on('error', reject);
    res.on('finish', resolve);
    nodeStream.pipe(res);
  });
}

// =========================================================
// CREATE REQUEST
// =========================================================

async function createRequest(
  req,
  res,
  body
) {
  const workspace =
    clean(body.workspaceId);

  const draw =
    upper(body.drawCode);

  const fileId =
    clean(body.fileId);

  const requesterType =
    upper(body.requesterType);

  const requesterCode =
    upper(body.requesterCode);

  if (
    !workspace ||
    !draw ||
    !fileId ||
    !requesterType
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'ข้อมูล Relay Request ไม่ครบ'
    });
  }

  const workspaceCheck =
    await verifyWorkspace(
      workspace
    );

  if (!workspaceCheck.ok) {
    return res
      .status(
        workspaceCheck.status
      )
      .json({
        ok: false,
        message:
          workspaceCheck.message
      });
  }

  const drawCheck =
    await verifyDraw(
      workspace,
      draw
    );

  if (!drawCheck.ok) {
    return res
      .status(drawCheck.status)
      .json({
        ok: false,
        message:
          drawCheck.message
      });
  }

  const assetCheck =
    await verifyAsset(
      workspace,
      draw,
      fileId
    );

  if (!assetCheck.ok) {
    return res
      .status(assetCheck.status)
      .json({
        ok: false,
        message:
          assetCheck.message
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

    const allowed =
      await verifySubkeyHolder({
        workspaceId:
          workspace,

        drawCode:
          draw,

        fileId,

        subkeyCode:
          requesterCode
      });

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        message:
          'Subkey นี้ไม่มีสิทธิ์ขอไฟล์นี้'
      });
    }
  }

  // ---------------------------------------------
  // ถ้ามี Request เดิมที่ยังใช้งานอยู่
  // ใช้ตัวเดิม ไม่สร้างซ้ำ
  // ---------------------------------------------

  const existing =
    await sql`
      select *

      from bridge_relay_requests

      where workspace_id =
        ${workspace}

        and draw_code =
          ${draw}

        and file_id =
          ${fileId}

        and requester_type =
          ${requesterType}

        and coalesce(
          requester_code,
          ''
        ) =
          ${requesterCode}

        and status in (
          'WAITING',
          'CLAIMED',
          'TRANSFERRING',
          'READY'
        )

        and expires_at >
          now()

      order by
        created_at desc

      limit 1
    `;

  if (existing.length) {
    return res.status(200).json({
      ok: true,
      reused: true,

      message:
        'พบ Relay Request เดิมที่ยังใช้งานอยู่',

      request:
        mapRequest(existing[0])
    });
  }

  const requestId =
    makeRequestId();

  const created =
    await sql`
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
        ${fileId},
        ${requesterType},
        ${requesterCode || null},
        'WAITING',
        now(),
        now(),
        now() +
          interval '5 minutes'
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
        assetCheck.asset.file_id,

      sourceFilename:
        assetCheck.asset
          .source_filename
    },

    request:
      mapRequest(created[0])
  });
}

// =========================================================
// BRIDGE CLAIM
// =========================================================

async function claimNext(
  req,
  res,
  body
) {
  const workspace =
    clean(body.workspaceId);

  const bridgeCode =
    upper(body.bridgeCode);

  if (
    !workspace ||
    !bridgeCode
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'Workspace หรือ Bridge Code ไม่ครบ'
    });
  }

  const workspaceCheck =
    await verifyWorkspace(
      workspace
    );

  if (!workspaceCheck.ok) {
    return res
      .status(
        workspaceCheck.status
      )
      .json({
        ok: false,
        message:
          workspaceCheck.message
      });
  }

  const claimed =
    await sql`
      with next_request as (

        select
          id

        from bridge_relay_requests

        where workspace_id =
          ${workspace}

          and status =
            'WAITING'

          and expires_at >
            now()

        order by
          created_at asc,
          id asc

        for update
        skip locked

        limit 1
      )

      update bridge_relay_requests

      set
        status =
          'CLAIMED',

        bridge_code =
          ${bridgeCode},

        claimed_at =
          now(),

        updated_at =
          now(),

        expires_at =
          now() +
          interval '5 minutes'

      where id = (
        select id
        from next_request
      )

        and status =
          'WAITING'

      returning *
    `;

  if (!claimed.length) {
    return res.status(200).json({
      ok: true,
      empty: true,

      message:
        'ไม่มี Relay Request ที่รอ Bridge'
    });
  }

  const request =
    claimed[0];

  const assetRows =
    await sql`
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

      where workspace_id =
        ${workspace}

        and file_id =
          ${request.file_id}

      limit 1
    `;

  if (!assetRows.length) {
    await sql`
      update bridge_relay_requests

      set
        status =
          'FAILED',

        updated_at =
          now()

      where request_id =
        ${request.request_id}
    `;

    return res.status(409).json({
      ok: false,
      message:
        'พบ Request แต่ไม่พบ File Asset'
    });
  }

  const asset =
    assetRows[0];

  if (asset.status !== 'AVAILABLE') {
    return res.status(409).json({
      ok: false,
      message:
        'File Asset ไม่พร้อมใช้งาน'
    });
  }

  return res.status(200).json({
    ok: true,
    empty: false,

    message:
      'Bridge รับ Relay Request สำเร็จ',

    request:
      mapRequest(request),

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
// MARK TRANSFERRING
// =========================================================

async function markTransferring(
  req,
  res,
  body
) {
  const workspace =
    clean(body.workspaceId);

  const bridgeCode =
    upper(body.bridgeCode);

  const requestId =
    clean(body.requestId);

  const rows =
    await sql`
      update bridge_relay_requests

      set
        status =
          'TRANSFERRING',

        updated_at =
          now(),

        expires_at =
          now() +
          interval '5 minutes'

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

        and upper(
          coalesce(
            bridge_code,
            ''
          )
        ) =
          ${bridgeCode}

        and status =
          'CLAIMED'

      returning *
    `;

  if (!rows.length) {
    return res.status(409).json({
      ok: false,
      message:
        'ไม่สามารถเปลี่ยนเป็น TRANSFERRING ได้'
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
// RELEASE
// =========================================================

async function releaseRequest(
  req,
  res,
  body
) {
  const workspace =
    clean(body.workspaceId);

  const bridgeCode =
    upper(body.bridgeCode);

  const requestId =
    clean(body.requestId);

  const rows =
    await sql`
      update bridge_relay_requests

      set
        status =
          'WAITING',

        bridge_code =
          null,

        claimed_at =
          null,

        updated_at =
          now(),

        expires_at =
          now() +
          interval '5 minutes'

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

        and upper(
          coalesce(
            bridge_code,
            ''
          )
        ) =
          ${bridgeCode}

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
        'ไม่สามารถคืน Relay Request ได้'
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

// =========================================================
// COMPLETE
// =========================================================

async function completeRequest(
  req,
  res,
  body
) {
  const workspace =
    clean(body.workspaceId);

  const bridgeCode =
    upper(body.bridgeCode);

  const requestId =
    clean(body.requestId);

  const rows =
    await sql`
      update bridge_relay_requests

      set
        status =
          'COMPLETED',

        completed_at =
          now(),

        updated_at =
          now()

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

        and upper(
          coalesce(
            bridge_code,
            ''
          )
        ) =
          ${bridgeCode}

        and status in (
          'CLAIMED',
          'TRANSFERRING',
          'READY'
        )

      returning *
    `;

  if (!rows.length) {
    return res.status(409).json({
      ok: false,
      message:
        'ไม่สามารถ Complete Relay Request ได้'
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
// UPLOAD BINARY -> PRIVATE BLOB
// =========================================================

async function uploadFile(
  req,
  res
) {
  const workspace =
    clean(req.query?.workspaceId);

  const requestId =
    clean(req.query?.requestId);

  const fileId =
    clean(req.query?.fileId);

  const bridgeCode =
    upper(req.query?.bridgeCode);

  const filename =
    safeFilename(
      req.query?.filename
    );

  if (
    !workspace ||
    !requestId ||
    !fileId ||
    !bridgeCode
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'ข้อมูล Upload ไม่ครบ'
    });
  }

  const requestRows =
    await sql`
      select *

      from bridge_relay_requests

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

      limit 1
    `;

  if (!requestRows.length) {
    return res.status(404).json({
      ok: false,
      message:
        'ไม่พบ Relay Request'
    });
  }

  const relay =
    requestRows[0];

  if (
    relay.file_id !==
    fileId
  ) {
    return res.status(409).json({
      ok: false,
      message:
        'File ID ไม่ตรงกับ Request'
    });
  }

  if (
    upper(relay.bridge_code) !==
    bridgeCode
  ) {
    return res.status(403).json({
      ok: false,
      message:
        'Bridge นี้ไม่ได้ถือ Request นี้'
    });
  }

  if (
    ![
      'CLAIMED',
      'TRANSFERRING'
    ].includes(
      relay.status
    )
  ) {
    return res.status(409).json({
      ok: false,
      message:
        'Request ไม่อยู่ในสถานะที่ Upload ได้'
    });
  }

  if (
    new Date(
      relay.expires_at
    ) <=
    new Date()
  ) {
    return res.status(410).json({
      ok: false,
      message:
        'Relay Request หมดอายุแล้ว'
    });
  }

  await sql`
    update bridge_relay_requests

    set
      status =
        'TRANSFERRING',

      updated_at =
        now(),

      expires_at =
        now() +
        interval '5 minutes'

    where request_id =
      ${requestId}
  `;

  const fileBuffer =
    await readRawBody(req);

  if (!fileBuffer.length) {
    return res.status(400).json({
      ok: false,
      message:
        'ไม่พบข้อมูลไฟล์'
    });
  }

  const contentType =
    clean(
      req.headers[
        'content-type'
      ]
    ) ||
    'application/octet-stream';

  const pathname =
    [
      'relay',
      workspace,
      relay.draw_code,
      requestId,
      fileId,
      filename
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

  const ready =
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
          now(),

        expires_at =
          now() +
          interval '10 minutes'

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

        and upper(
          coalesce(
            bridge_code,
            ''
          )
        ) =
          ${bridgeCode}

      returning *
    `;

  if (!ready.length) {
    return res.status(409).json({
      ok: false,

      message:
        'Upload สำเร็จ แต่บันทึกสถานะ Relay ไม่สำเร็จ'
    });
  }

  return res.status(200).json({
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
}

// =========================================================
// GET STATUS
// =========================================================

async function getStatus(
  req,
  res
) {
  const workspace =
    clean(req.query?.workspaceId);

  const requestId =
    clean(req.query?.requestId);

  if (
    !workspace ||
    !requestId
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'Workspace หรือ Request ID ไม่ครบ'
    });
  }

  const rows =
    await sql`
      select *

      from bridge_relay_requests

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

      limit 1
    `;

  if (!rows.length) {
    return res.status(404).json({
      ok: false,
      message:
        'ไม่พบ Relay Request'
    });
  }

  return res.status(200).json({
    ok: true,

    request:
      mapRequest(rows[0])
  });
}

// =========================================================
// DOWNLOAD PRIVATE BLOB -> S
// =========================================================

async function downloadFile(
  req,
  res
) {
  const workspace =
    clean(req.query?.workspaceId);

  const requestId =
    clean(req.query?.requestId);

  const requesterType =
    upper(req.query?.requesterType);

  const requesterCode =
    upper(req.query?.requesterCode);

  if (
    !workspace ||
    !requestId ||
    !requesterType
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'ข้อมูล Download ไม่ครบ'
    });
  }

  const rows =
    await sql`
      select *

      from bridge_relay_requests

      where request_id =
        ${requestId}

        and workspace_id =
          ${workspace}

      limit 1
    `;

  if (!rows.length) {
    return res.status(404).json({
      ok: false,
      message:
        'ไม่พบ Relay Request'
    });
  }

  const relay =
    rows[0];

  if (relay.status !== 'READY') {
    return res.status(409).json({
      ok: false,
      message:
        'Relay Request ยังไม่พร้อม Download'
    });
  }

  if (
    upper(
      relay.requester_type
    ) !==
    requesterType
  ) {
    return res.status(403).json({
      ok: false,
      message:
        'Requester Type ไม่ตรง'
    });
  }

  if (requesterType === 'S') {
    if (
      !requesterCode ||
      upper(
        relay.requester_code
      ) !== requesterCode
    ) {
      return res.status(403).json({
        ok: false,
        message:
          'Subkey นี้ไม่มีสิทธิ์ Download'
      });
    }

    const allowed =
      await verifySubkeyHolder({
        workspaceId:
          workspace,

        drawCode:
          relay.draw_code,

        fileId:
          relay.file_id,

        subkeyCode:
          requesterCode
      });

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        message:
          'Subkey นี้ไม่ได้ถือโพยนี้อยู่แล้ว'
      });
    }
  }

  if (
    !relay.relay_blob_pathname
  ) {
    return res.status(409).json({
      ok: false,
      message:
        'ไม่พบ Private Blob Path'
    });
  }

  const result =
    await get(
      relay.relay_blob_pathname,
      {
        access:
          'private'
      }
    );

  if (!result) {
    return res.status(404).json({
      ok: false,
      message:
        'ไม่พบไฟล์ใน Private Relay'
    });
  }

  res.statusCode = 200;

  res.setHeader(
    'Content-Type',
    relay.relay_content_type ||
      result.blob?.contentType ||
      'application/octet-stream'
  );

  res.setHeader(
    'Cache-Control',
    'private, no-store'
  );

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  if (
    relay.relay_file_size_bytes
  ) {
    res.setHeader(
      'Content-Length',
      String(
        relay.relay_file_size_bytes
      )
    );
  }

  // @vercel/blob get() คืน ReadableStream
  // แปลงเป็น Node stream แล้ว pipe กลับ Browser
  const nodeStream =
    Readable.fromWeb(
      result.stream
    );

  await new Promise(
    (resolve, reject) => {
      nodeStream.on(
        'error',
        reject
      );

      res.on(
        'finish',
        resolve
      );

      nodeStream.pipe(res);
    }
  );

  // หลังส่งถึง S สำเร็จ
  await sql`
    update bridge_relay_requests

    set
      status =
        'COMPLETED',

      completed_at =
        now(),

      updated_at =
        now()

    where request_id =
      ${requestId}

      and status =
        'READY'
  `;
}

// =========================================================
// MAIN HANDLER
// =========================================================

export default async function handler(
  req,
  res
) {
  try {

    // =====================================================
    // GET
    // /api/relay?action=STATUS
    // /api/relay?action=DOWNLOAD
    // =====================================================

    if (req.method === 'GET') {
      const action =
        upper(
          req.query?.action
        );

      if (action === 'STATUS') {
        return await getStatus(
          req,
          res
        );
      }

      if (action === 'DOWNLOAD') {
        return await downloadFile(
          req,
          res
        );
      }

      if (action === 'PREVIEW_STATUS') {
        return await previewStatus(
          req,
          res
        );
      }

      if (action === 'PREVIEW_DOWNLOAD') {
        return await previewDownload(
          req,
          res
        );
      }

      return res.status(400).json({
        ok: false,
        message:
          'GET Action ไม่ถูกต้อง'
      });
    }

    // =====================================================
    // POST UPLOAD BINARY
    //
    // /api/relay?action=UPLOAD&...
    // =====================================================

    if (req.method === 'POST') {

      const queryAction =
        upper(
          req.query?.action
        );

      if (queryAction === 'UPLOAD') {
        return await uploadFile(
          req,
          res
        );
      }

      if (queryAction === 'PRESTAGE_UPLOAD') {
        return await prestageUpload(
          req,
          res
        );
      }

      // -----------------------------------------------
      // JSON Actions
      // -----------------------------------------------

      const body =
        await readJsonBody(req);

      const action =
        upper(body.action);

      if (action === 'CLAIM_PRESTAGE') {
        return await claimPrestage(
          req,
          res,
          body
        );
      }

      if (action === 'CREATE_REQUEST') {
        return await createRequest(
          req,
          res,
          body
        );
      }

      if (action === 'CLAIM_NEXT') {
        return await claimNext(
          req,
          res,
          body
        );
      }

      if (
        action ===
        'MARK_TRANSFERRING'
      ) {
        return await markTransferring(
          req,
          res,
          body
        );
      }

      if (action === 'RELEASE') {
        return await releaseRequest(
          req,
          res,
          body
        );
      }

      if (action === 'COMPLETE') {
        return await completeRequest(
          req,
          res,
          body
        );
      }

      return res.status(400).json({
        ok: false,
        message:
          'POST Action ไม่ถูกต้อง'
      });
    }

    return res.status(405).json({
      ok: false,
      message:
        'Method not allowed'
    });

  } catch (error) {

    console.error(
      'relay api error:',
      error
    );

    if (
      error?.code ===
      'UPLOAD_TOO_LARGE'
    ) {
      return res.status(413).json({
        ok: false,
        message:
          'ไฟล์ใหญ่เกิน 15MB'
      });
    }

    if (
      error?.code ===
      'INVALID_JSON'
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'JSON ไม่ถูกต้อง'
      });
    }

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        message:
          'ระบบ T999 Relay เกิดข้อผิดพลาด'
      });
    }

    res.destroy();
  }
}

// ต้องปิด bodyParser เพราะ endpoint เดียว
// รับทั้ง JSON และ binary image
export const config = {
  api: {
    bodyParser: false
  }
};
