import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mapEntry(row) {
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    drawCode: row.draw_code,
    slipId: row.slip_id,
    fileId: row.file_id,
    entrySeq: Number(row.entry_seq),
    numberValue: row.number_value,
    betType: row.bet_type,
    amount: Number(row.amount),
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode }) {
  const rows = await sql`
    select id, workspace_id, draw_code, slip_id, file_id, queue_status, assigned_subkey
    from intake_slips
    where workspace_id = ${workspaceId}
      and upper(coalesce(draw_code, '')) = ${upper(drawCode)}
      and slip_id = ${slipId}
    limit 1
  `;

  if (!rows.length) {
    return { ok: false, status: 404, message: 'ไม่พบโพยนี้' };
  }

  const slip = rows[0];

  if (slip.queue_status !== 'IN_PROGRESS') {
    return { ok: false, status: 409, message: 'โพยนี้ไม่ได้อยู่ในสถานะ IN_PROGRESS' };
  }

  if (!subkeyCode || upper(slip.assigned_subkey) !== upper(subkeyCode)) {
    return { ok: false, status: 403, message: 'Subkey นี้ไม่ได้ถือโพยนี้อยู่' };
  }

  return { ok: true, slip };
}

async function addEntry(res, body) {
  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const slipId = clean(body.slipId);
  const subkeyCode = upper(body.subkeyCode);
  const numberValue = clean(body.numberValue);
  const betType = upper(body.betType);
  const amount = normalizeAmount(body.amount);

  if (!workspaceId || !drawCode || !slipId || !subkeyCode) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลโพยหรือ Subkey ไม่ครบ' });
  }

  if (!/^[0-9]{1,5}$/.test(numberValue)) {
    return res.status(400).json({ ok: false, message: 'เลขต้องเป็นตัวเลข 1-5 หลัก' });
  }

  if (!betType) {
    return res.status(400).json({ ok: false, message: 'ไม่พบประเภทการเดิมพัน' });
  }

  if (amount === null) {
    return res.status(400).json({ ok: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  }

  const holder = await verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode });

  if (!holder.ok) {
    return res.status(holder.status).json({ ok: false, message: holder.message });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const rows = await sql`
        insert into slip_entries (
          workspace_id, draw_code, slip_id, file_id, entry_seq,
          number_value, bet_type, amount, created_by, created_at, updated_at
        )
        select
          ${workspaceId},
          ${drawCode},
          ${slipId},
          ${holder.slip.file_id},
          coalesce(max(entry_seq), 0) + 1,
          ${numberValue},
          ${betType},
          ${amount},
          ${subkeyCode},
          now(),
          now()
        from slip_entries
        where workspace_id = ${workspaceId}
          and slip_id = ${slipId}
        returning *
      `;

      return res.status(201).json({
        ok: true,
        message: 'เพิ่มรายการสำเร็จ',
        entry: mapEntry(rows[0])
      });
    } catch (error) {
      if (error?.code !== '23505' || attempt === 2) {
        throw error;
      }
    }
  }
}


async function batchAddEntries(res, body) {
  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const slipId = clean(body.slipId);
  const subkeyCode = upper(body.subkeyCode);
  const entries = Array.isArray(body.entries) ? body.entries : [];

  if (!workspaceId || !drawCode || !slipId || !subkeyCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลโพยหรือ Subkey ไม่ครบ'
    });
  }

  if (!entries.length || entries.length > 100) {
    return res.status(400).json({
      ok: false,
      message: 'จำนวนรายการไม่ถูกต้อง'
    });
  }

  const normalized = [];

  for (const item of entries) {
    const numberValue = clean(item.numberValue);
    const betType = upper(item.betType);
    const amount = normalizeAmount(item.amount);

    if (!/^[0-9]{1,5}$/.test(numberValue)) {
      return res.status(400).json({
        ok: false,
        message: 'มีเลขไม่ถูกต้องในชุดรายการ'
      });
    }

    if (!betType || amount === null) {
      return res.status(400).json({
        ok: false,
        message: 'มีประเภทหรือราคาไม่ถูกต้องในชุดรายการ'
      });
    }

    normalized.push({
      numberValue,
      betType,
      amount
    });
  }

  const holder = await verifySlipHolder({
    workspaceId,
    drawCode,
    slipId,
    subkeyCode
  });

  if (!holder.ok) {
    return res.status(holder.status).json({
      ok: false,
      message: holder.message
    });
  }

  const numbers = normalized.map(item => item.numberValue);
  const types = normalized.map(item => item.betType);
  const amounts = normalized.map(item => item.amount);

  const rows = await sql`
    with base as (
      select coalesce(max(entry_seq), 0) as max_seq
      from slip_entries
      where workspace_id = ${workspaceId}
        and slip_id = ${slipId}
    ),
    input as (
      select *
      from unnest(
        ${numbers}::text[],
        ${types}::text[],
        ${amounts}::numeric[]
      ) with ordinality
      as t(number_value, bet_type, amount, ord)
    )
    insert into slip_entries (
      workspace_id,
      draw_code,
      slip_id,
      file_id,
      entry_seq,
      number_value,
      bet_type,
      amount,
      created_by,
      created_at,
      updated_at
    )
    select
      ${workspaceId},
      ${drawCode},
      ${slipId},
      ${holder.slip.file_id},
      base.max_seq + input.ord::integer,
      input.number_value,
      input.bet_type,
      input.amount,
      ${subkeyCode},
      now(),
      now()
    from input
    cross join base
    returning *
  `;

  return res.status(201).json({
    ok: true,
    message: 'เพิ่มรายการชุดสำเร็จ',
    entries: rows.map(mapEntry)
  });
}

async function updateEntry(res, body) {
  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const slipId = clean(body.slipId);
  const subkeyCode = upper(body.subkeyCode);
  const entryId = Number(body.entryId);
  const numberValue = clean(body.numberValue);
  const betType = upper(body.betType);
  const amount = normalizeAmount(body.amount);

  if (!workspaceId || !drawCode || !slipId || !subkeyCode || !Number.isSafeInteger(entryId) || entryId <= 0) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลแก้รายการไม่ครบ' });
  }

  if (!/^[0-9]{1,5}$/.test(numberValue)) {
    return res.status(400).json({ ok: false, message: 'เลขต้องเป็นตัวเลข 1-5 หลัก' });
  }

  if (!betType) {
    return res.status(400).json({ ok: false, message: 'ไม่พบประเภทการเดิมพัน' });
  }

  if (amount === null) {
    return res.status(400).json({ ok: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  }

  const holder = await verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode });

  if (!holder.ok) {
    return res.status(holder.status).json({ ok: false, message: holder.message });
  }

  const rows = await sql`
    update slip_entries
    set number_value = ${numberValue},
        bet_type = ${betType},
        amount = ${amount},
        updated_at = now()
    where id = ${entryId}
      and workspace_id = ${workspaceId}
      and draw_code = ${drawCode}
      and slip_id = ${slipId}
    returning *
  `;

  if (!rows.length) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการที่ต้องการแก้' });
  }

  return res.status(200).json({
    ok: true,
    message: 'แก้รายการสำเร็จ',
    entry: mapEntry(rows[0])
  });
}

async function deleteEntry(res, body) {
  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const slipId = clean(body.slipId);
  const subkeyCode = upper(body.subkeyCode);
  const entryId = Number(body.entryId);

  if (!workspaceId || !drawCode || !slipId || !subkeyCode || !Number.isSafeInteger(entryId) || entryId <= 0) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลลบรายการไม่ครบ' });
  }

  const holder = await verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode });

  if (!holder.ok) {
    return res.status(holder.status).json({ ok: false, message: holder.message });
  }

  const rows = await sql`
    delete from slip_entries
    where id = ${entryId}
      and workspace_id = ${workspaceId}
      and draw_code = ${drawCode}
      and slip_id = ${slipId}
    returning *
  `;

  if (!rows.length) {
    return res.status(404).json({ ok: false, message: 'ไม่พบรายการที่ต้องการลบ' });
  }

  return res.status(200).json({
    ok: true,
    message: 'ลบรายการสำเร็จ',
    entry: mapEntry(rows[0])
  });
}


async function listExposureIndex(req, res) {
  const workspaceId = clean(req.query?.workspaceId);
  const drawCode = upper(req.query?.drawCode);

  if (!workspaceId || !drawCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Workspace/งวดไม่ครบ'
    });
  }

  const rows = await sql`
    select
      e.bet_type,
      e.number_value,
      count(*)::integer as entry_count,
      count(distinct e.slip_id)::integer as slip_count,
      coalesce(sum(e.amount), 0)::numeric as gross_amount
    from slip_entries e
    join intake_slips s
      on s.workspace_id = e.workspace_id
     and s.slip_id = e.slip_id
    where e.workspace_id = ${workspaceId}
      and upper(coalesce(e.draw_code, '')) = ${drawCode}
      and s.queue_status = 'COMPLETED'
    group by
      e.bet_type,
      e.number_value
    order by
      e.bet_type asc,
      coalesce(sum(e.amount), 0) desc,
      e.number_value asc
  `;

  const summaryRows = await sql`
    select
      count(distinct e.slip_id)::integer as slip_count,
      count(*)::integer as entry_count,
      coalesce(sum(e.amount), 0)::numeric as gross_amount
    from slip_entries e
    join intake_slips s
      on s.workspace_id = e.workspace_id
     and s.slip_id = e.slip_id
    where e.workspace_id = ${workspaceId}
      and upper(coalesce(e.draw_code, '')) = ${drawCode}
      and s.queue_status = 'COMPLETED'
  `;

  const summary = summaryRows[0] || {};

  return res.status(200).json({
    ok: true,
    sourceOfTruth: 'COMPLETED_SLIP_ENTRIES',
    workspaceId,
    drawCode,
    items: rows.map(row => ({
      betType: row.bet_type,
      numberValue: row.number_value,
      entryCount: Number(row.entry_count || 0),
      slipCount: Number(row.slip_count || 0),
      grossAmount: Number(row.gross_amount || 0)
    })),
    summary: {
      slipCount: Number(summary.slip_count || 0),
      entryCount: Number(summary.entry_count || 0),
      grossAmount: Number(summary.gross_amount || 0)
    }
  });
}

async function listEntries(req, res) {
  const workspaceId = clean(req.query?.workspaceId);
  const drawCode = upper(req.query?.drawCode);
  const slipId = clean(req.query?.slipId);
  const subkeyCode = upper(req.query?.subkeyCode);

  if (!workspaceId || !drawCode || !slipId || !subkeyCode) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลโหลดรายการไม่ครบ' });
  }

  const holder = await verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode });

  if (!holder.ok) {
    return res.status(holder.status).json({ ok: false, message: holder.message });
  }

  const rows = await sql`
    select *
    from slip_entries
    where workspace_id = ${workspaceId}
      and draw_code = ${drawCode}
      and slip_id = ${slipId}
    order by entry_seq desc, id desc
  `;

  const totalAmount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return res.status(200).json({
    ok: true,
    displayOrder: 'LATEST_FIRST',
    entries: rows.map(mapEntry),
    summary: {
      count: rows.length,
      totalAmount
    }
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const mode = upper(req.query?.mode);

      if (mode === 'EXPOSURE_INDEX') {
        return await listExposureIndex(req, res);
      }

      return await listEntries(req, res);
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const action = upper(body.action);

      if (action === 'ADD') {
        return await addEntry(res, body);
      }

      if (action === 'BATCH_ADD') {
        return await batchAddEntries(res, body);
      }

      if (action === 'UPDATE') {
        return await updateEntry(res, body);
      }

      if (action === 'DELETE') {
        return await deleteEntry(res, body);
      }

      return res.status(400).json({ ok: false, message: 'Action ไม่ถูกต้อง' });
    }

    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  } catch (error) {
    console.error('slip-entries api error:', error);

    return res.status(500).json({
      ok: false,
      message: 'ระบบรายการคีย์เกิดข้อผิดพลาด'
    });
  }
}
