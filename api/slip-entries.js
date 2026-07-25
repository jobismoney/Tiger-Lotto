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
    restrictionMode: row.restriction_mode || 'NONE',
    restrictionPercent: Number(row.restriction_percent || 0),
    restrictionLabel: row.restriction_label || '',
    closedAcceptStatus: row.closed_accept_status || '',
    closedReviewStatus: row.closed_review_status || '',
    isCounted: row.is_counted !== false,
    restrictionSnapshotAt: row.restriction_snapshot_at || null,
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode }) {
  const rows = await sql`
    select id, workspace_id, draw_code, slip_id, file_id, queue_status, assigned_subkey, received_at, claimed_at
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
        restriction_mode = 'NONE',
        restriction_percent = 0,
        restriction_label = null,
        closed_accept_status = null,
        closed_review_status = null,
        is_counted = true,
        matched_closed_number_id = null,
        restriction_snapshot_at = null,
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



async function ensureExposureTables() {
  await sql`
    create table if not exists exposure_adjustments (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      bet_type text not null,
      number_value text not null,
      adjustment_type text not null,
      amount numeric(14,2) not null default 0,
      status text not null default 'CONFIRMED',
      note text,
      created_by text,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists idx_exposure_adjustments_lookup
    on exposure_adjustments (
      workspace_id,
      draw_code,
      bet_type,
      number_value,
      adjustment_type,
      status,
      created_at
    )
  `;

  await sql`
    create table if not exists exposure_type_limits (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      category_key text not null,
      limit_amount numeric(14,2) not null default 0,
      is_enabled boolean not null default true,
      updated_by text,
      updated_at timestamptz not null default now(),
      unique(workspace_id, draw_code, category_key)
    )
  `;

  await sql`
    create index if not exists idx_exposure_type_limits_lookup
    on exposure_type_limits (
      workspace_id,
      draw_code,
      category_key,
      is_enabled
    )
  `;

  await sql`
    create table if not exists exposure_cut_rounds (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      round_no integer not null,
      round_code text not null,
      status text not null default 'DRAFT',
      created_by text,
      created_at timestamptz not null default now(),
      confirmed_by text,
      confirmed_at timestamptz,
      unique(workspace_id, draw_code, round_no),
      unique(workspace_id, draw_code, round_code)
    )
  `;

  await sql`
    create table if not exists exposure_cut_items (
      id bigserial primary key,
      round_id bigint not null references exposure_cut_rounds(id) on delete cascade,
      workspace_id text not null,
      draw_code text not null,
      bet_type text not null,
      number_value text not null,
      cut_amount numeric(14,2) not null default 0,
      created_at timestamptz not null default now(),
      unique(round_id, bet_type, number_value)
    )
  `;

  await sql`
    create index if not exists idx_exposure_cut_items_lookup
    on exposure_cut_items (
      workspace_id,
      draw_code,
      bet_type,
      number_value,
      round_id
    )
  `;

  await sql`
    alter table exposure_cut_rounds
    add column if not exists snapshot_at timestamptz
  `;

  await sql`
    alter table exposure_cut_items
    add column if not exists snapshot_amount numeric(14,2) not null default 0
  `;
}

async function addExposureAdjustment(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const betType = upper(body.betType);
  const numberValue = clean(body.numberValue);
  const adjustmentType = upper(body.adjustmentType);
  const amount = normalizeAmount(body.amount);
  const note = clean(body.note);
  const effectiveTime = clean(body.effectiveTime);
  const createdBy = upper(body.createdBy || 'M');

  if (!workspaceId || !drawCode || !betType || !numberValue) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Exposure adjustment ไม่ครบ'
    });
  }

  if (!/^[0-9]{1,5}$/.test(numberValue)) {
    return res.status(400).json({
      ok: false,
      message: 'เลขไม่ถูกต้อง'
    });
  }

  if (!['LIMIT', 'CUT'].includes(adjustmentType)) {
    return res.status(400).json({
      ok: false,
      message: 'ประเภท adjustment ไม่ถูกต้อง'
    });
  }

  if (amount === null || amount < 0) {
    return res.status(400).json({
      ok: false,
      message: 'ยอดไม่ถูกต้อง'
    });
  }

  const rows = await sql`
    insert into exposure_adjustments (
      workspace_id,
      draw_code,
      bet_type,
      number_value,
      adjustment_type,
      amount,
      status,
      note,
      created_by,
      created_at
    )
    values (
      ${workspaceId},
      ${drawCode},
      ${betType},
      ${numberValue},
      ${adjustmentType},
      ${amount},
      'CONFIRMED',
      ${note || null},
      ${createdBy},
      now()
    )
    returning *
  `;

  return res.status(201).json({
    ok: true,
    message: adjustmentType === 'LIMIT'
      ? 'บันทึกยอดอั้นแล้ว'
      : 'บันทึกยอดตีออกยืนยันแล้ว',
    adjustment: rows[0]
  });
}


function exposureCategoryKey(numberValue, betType) {
  const digits = clean(numberValue).length;
  const type = upper(betType);

  if (digits === 1 && type === 'วิ่งบน') return 'RUN_TOP';
  if (digits === 1 && type === 'วิ่งล่าง') return 'RUN_BOTTOM';

  if (digits === 2 && type === 'บน') return '2_TOP';
  if (digits === 2 && type === 'ล่าง') return '2_BOTTOM';
  if (digits === 2 && type === 'หน้า') return '2_FRONT';
  if (digits === 2 && type === 'โต๊ด') return 'TOOD_2';

  if (digits === 3 && type === 'บน') return '3_TOP';
  if (digits === 3 && type === 'ล่าง') return '3_BOTTOM';
  if (digits === 3 && type === 'หน้า') return '3_FRONT';
  if (digits === 3 && type === 'โต๊ด') return 'TOOD_3';

  if (digits === 4 && type === 'โต๊ด') return 'TOOD_4';
  if (digits === 5 && type === 'โต๊ด') return 'TOOD_5';

  return `${digits}_${type || 'UNKNOWN'}`;
}

async function upsertExposureTypeLimit(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const categoryKey = upper(body.categoryKey);
  const limitAmount = normalizeAmount(body.limitAmount);
  const isEnabled = body.isEnabled !== false;
  const updatedBy = upper(body.updatedBy || 'M');

  if (!workspaceId || !drawCode || !categoryKey) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลตั้งอั้นไม่ครบ'
    });
  }

  if (limitAmount === null || limitAmount < 0) {
    return res.status(400).json({
      ok: false,
      message: 'ยอดอั้นไม่ถูกต้อง'
    });
  }

  const rows = await sql`
    insert into exposure_type_limits (
      workspace_id,
      draw_code,
      category_key,
      limit_amount,
      is_enabled,
      updated_by,
      updated_at
    )
    values (
      ${workspaceId},
      ${drawCode},
      ${categoryKey},
      ${limitAmount},
      ${isEnabled},
      ${updatedBy},
      now()
    )
    on conflict (
      workspace_id,
      draw_code,
      category_key
    )
    do update set
      limit_amount = excluded.limit_amount,
      is_enabled = excluded.is_enabled,
      updated_by = excluded.updated_by,
      updated_at = now()
    returning *
  `;

  return res.status(200).json({
    ok: true,
    message: 'บันทึกอั้นตามประเภทแล้ว',
    limit: rows[0]
  });
}

async function listExposureTypeLimits(req, res) {
  await ensureExposureTables();

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
      category_key,
      limit_amount,
      is_enabled,
      updated_by,
      updated_at
    from exposure_type_limits
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    order by category_key asc
  `;

  return res.status(200).json({
    ok: true,
    limits: rows.map(row => ({
      categoryKey: row.category_key,
      limitAmount: Number(row.limit_amount || 0),
      isEnabled: Boolean(row.is_enabled),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at
    }))
  });
}


async function createCutRound(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const createdBy = upper(body.createdBy || 'M');

  if (!workspaceId || !drawCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Workspace/งวดไม่ครบ'
    });
  }

  const existingDraftRows = await sql`
    select
      r.*,
      count(i.id)::integer as item_count
    from exposure_cut_rounds r
    left join exposure_cut_items i
      on i.round_id = r.id
    where r.workspace_id = ${workspaceId}
      and upper(r.draw_code) = ${drawCode}
      and r.status = 'DRAFT'
    group by r.id
    order by r.round_no desc
    limit 1
  `;

  const existingDraft =
    existingDraftRows[0] || null;

  const timeRows = await sql`
    select now() as snapshot_at
  `;

  const snapshotAt =
    timeRows[0].snapshot_at;

  let round = null;
  let roundCode = '';

  if (existingDraft) {
    const itemCount =
      Number(existingDraft.item_count || 0);

    if (itemCount > 0) {
      return res.status(200).json({
        ok: true,
        message:
          `มี Snapshot ${existingDraft.round_code} อยู่แล้ว`,
        round: existingDraft,
        itemCount
      });
    }

    // DRAFT ว่างต้องไม่บล็อก Snapshot ใหม่:
    // ใช้เลขรอบเดิม แต่ refresh snapshot_at และ rebuild items จาก Exposure สด
    const refreshedRows = await sql`
      update exposure_cut_rounds
      set
        snapshot_at = ${snapshotAt},
        created_at = now(),
        created_by = ${createdBy}
      where id = ${existingDraft.id}
      returning *
    `;

    round = refreshedRows[0];
    roundCode = round.round_code;

    await sql`
      delete from exposure_cut_items
      where round_id = ${round.id}
    `;
  } else {
    const nextRows = await sql`
      select
        coalesce(max(round_no), 0) + 1
        as next_no
      from exposure_cut_rounds
      where workspace_id = ${workspaceId}
        and upper(draw_code) = ${drawCode}
    `;

    const roundNo =
      Number(nextRows[0]?.next_no || 1);

    roundCode =
      'R' + String(roundNo).padStart(3, '0');

    const roundRows = await sql`
      insert into exposure_cut_rounds (
        workspace_id,
        draw_code,
        round_no,
        round_code,
        status,
        created_by,
        created_at,
        snapshot_at
      )
      values (
        ${workspaceId},
        ${drawCode},
        ${roundNo},
        ${roundCode},
        'DRAFT',
        ${createdBy},
        now(),
        ${snapshotAt}
      )
      returning *
    `;

    round = roundRows[0];
  }

  const baseRows = await sql`
    select
      e.bet_type,
      e.number_value,
      coalesce(sum(e.amount), 0)::numeric
        as gross_amount
    from slip_entries e
    join intake_slips s
      on s.workspace_id = e.workspace_id
     and s.slip_id = e.slip_id
    where e.workspace_id = ${workspaceId}
      and upper(coalesce(e.draw_code, '')) = ${drawCode}
      and s.queue_status = 'COMPLETED'
      and coalesce(
        s.completed_at,
        s.updated_at,
        s.created_at
      ) <= ${snapshotAt}
    group by
      e.bet_type,
      e.number_value
  `;

  const limitRows = await sql`
    select
      category_key,
      limit_amount,
      is_enabled
    from exposure_type_limits
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
  `;

  const confirmedCutRows = await sql`
    select
      i.bet_type,
      i.number_value,
      coalesce(sum(i.cut_amount), 0)::numeric
        as cut_amount
    from exposure_cut_items i
    join exposure_cut_rounds r
      on r.id = i.round_id
    where i.workspace_id = ${workspaceId}
      and upper(i.draw_code) = ${drawCode}
      and r.status = 'CONFIRMED'
    group by
      i.bet_type,
      i.number_value
  `;

  const legacyCutRows = await sql`
    select
      bet_type,
      number_value,
      coalesce(sum(amount), 0)::numeric
        as cut_amount
    from exposure_adjustments
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
      and adjustment_type = 'CUT'
      and status = 'CONFIRMED'
    group by
      bet_type,
      number_value
  `;

  const limitMap = new Map(
    limitRows.map(row => [
      row.category_key,
      {
        amount: Number(row.limit_amount || 0),
        enabled: Boolean(row.is_enabled)
      }
    ])
  );

  const cutMap = new Map();

  for (const row of [...confirmedCutRows, ...legacyCutRows]) {
    const key =
      `${row.bet_type}|||${row.number_value}`;

    cutMap.set(
      key,
      (cutMap.get(key) || 0)
      + Number(row.cut_amount || 0)
    );
  }

  const snapshotItems = [];

  for (const row of baseRows) {
    const grossAmount =
      Number(row.gross_amount || 0);

    const categoryKey =
      exposureCategoryKey(
        row.number_value,
        row.bet_type
      );

    const typeLimit =
      limitMap.get(categoryKey);

    const limitAmount =
      typeLimit?.enabled
        ? Number(typeLimit.amount || 0)
        : 0;

    const priorCut =
      cutMap.get(
        `${row.bet_type}|||${row.number_value}`
      ) || 0;

    const snapshotBalance =
      Math.max(
        grossAmount
        - limitAmount
        - priorCut,
        0
      );

    if (snapshotBalance <= 0) {
      continue;
    }

    snapshotItems.push({
      betType: row.bet_type,
      numberValue: row.number_value,
      snapshotAmount: snapshotBalance,
      cutAmount: snapshotBalance
    });
  }

  for (const item of snapshotItems) {
    await sql`
      insert into exposure_cut_items (
        round_id,
        workspace_id,
        draw_code,
        bet_type,
        number_value,
        snapshot_amount,
        cut_amount,
        created_at
      )
      values (
        ${round.id},
        ${workspaceId},
        ${drawCode},
        ${item.betType},
        ${item.numberValue},
        ${item.snapshotAmount},
        ${item.cutAmount},
        now()
      )
    `;
  }

  return res.status(201).json({
    ok: true,
    message:
      snapshotItems.length
        ? `Snapshot ${roundCode} แล้ว`
        : `Snapshot ${roundCode} แล้ว แต่ยังไม่มียอดคงเหลือให้ตีออก`,
    round,
    itemCount: snapshotItems.length
  });
}

async function upsertCutRoundItem(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const roundId = Number(body.roundId);
  const betType = upper(body.betType);
  const numberValue = clean(body.numberValue);
  const cutAmount = normalizeAmount(body.cutAmount);

  if (!workspaceId || !drawCode || !roundId || !betType || !numberValue) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลรายการตีออกไม่ครบ'
    });
  }

  if (cutAmount === null || cutAmount < 0) {
    return res.status(400).json({
      ok: false,
      message: 'ยอดตีออกไม่ถูกต้อง'
    });
  }

  const roundRows = await sql`
    select *
    from exposure_cut_rounds
    where id = ${roundId}
      and workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    limit 1
  `;

  const round = roundRows[0];

  if (!round) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบรอบตีออก'
    });
  }

  if (round.status !== 'DRAFT') {
    return res.status(409).json({
      ok: false,
      message: 'รอบนี้ยืนยันแล้ว แก้ไม่ได้'
    });
  }

  const existingItemRows = await sql`
    select *
    from exposure_cut_items
    where round_id = ${roundId}
      and bet_type = ${betType}
      and number_value = ${numberValue}
    limit 1
  `;

  const existingItem = existingItemRows[0];

  if (!existingItem) {
    return res.status(404).json({
      ok: false,
      message: 'เลขนี้ไม่อยู่ใน Snapshot ของรอบ'
    });
  }

  const snapshotAmount = Number(
    existingItem.snapshot_amount || 0
  );

  if (cutAmount > snapshotAmount) {
    return res.status(400).json({
      ok: false,
      message: 'ยอดตีออกห้ามเกินยอด Snapshot'
    });
  }

  if (cutAmount === 0) {
    const rows = await sql`
      update exposure_cut_items
      set cut_amount = 0
      where round_id = ${roundId}
        and bet_type = ${betType}
        and number_value = ${numberValue}
      returning *
    `;

    return res.status(200).json({
      ok: true,
      message: 'ตั้งยอดตีออกเป็น 0 แล้ว',
      item: rows[0]
    });
  }

  const rows = await sql`
    insert into exposure_cut_items (
      round_id,
      workspace_id,
      draw_code,
      bet_type,
      number_value,
      snapshot_amount,
      cut_amount,
      created_at
    )
    values (
      ${roundId},
      ${workspaceId},
      ${drawCode},
      ${betType},
      ${numberValue},
      ${snapshotAmount},
      ${cutAmount},
      now()
    )
    on conflict (
      round_id,
      bet_type,
      number_value
    )
    do update set
      cut_amount = excluded.cut_amount
    returning *
  `;

  return res.status(200).json({
    ok: true,
    message: 'บันทึกรายการตีออกในรอบแล้ว',
    item: rows[0]
  });
}

async function confirmCutRound(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const roundId = Number(body.roundId);
  const confirmedBy = upper(body.confirmedBy || 'M');

  if (!workspaceId || !drawCode || !roundId) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลยืนยันรอบไม่ครบ'
    });
  }

  const rows = await sql`
    update exposure_cut_rounds
    set
      status = 'CONFIRMED',
      confirmed_by = ${confirmedBy},
      confirmed_at = now()
    where id = ${roundId}
      and workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
      and status = 'DRAFT'
    returning *
  `;

  if (!rows.length) {
    return res.status(409).json({
      ok: false,
      message: 'รอบนี้ไม่อยู่ในสถานะ DRAFT หรือถูกยืนยันแล้ว'
    });
  }

  return res.status(200).json({
    ok: true,
    message: `ยืนยัน ${rows[0].round_code} แล้ว`,
    round: rows[0]
  });
}


async function finalizeCutRound(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const roundId = Number(body.roundId);
  const confirmedBy = upper(body.confirmedBy || 'M');
  const edits = Array.isArray(body.edits) ? body.edits : [];

  if (!workspaceId || !drawCode || !roundId) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลยืนยันรอบไม่ครบ'
    });
  }

  const roundRows = await sql`
    select *
    from exposure_cut_rounds
    where id = ${roundId}
      and workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    limit 1
  `;

  const round = roundRows[0];

  if (!round) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบรอบตีออก'
    });
  }

  if (round.status !== 'DRAFT') {
    return res.status(409).json({
      ok: false,
      message: 'รอบนี้ถูกยืนยันแล้ว'
    });
  }

  const currentItems = await sql`
    select *
    from exposure_cut_items
    where round_id = ${roundId}
    order by id asc
  `;

  const byId = new Map(
    currentItems.map(item => [
      Number(item.id),
      item
    ])
  );

  const normalized = [];

  for (const edit of edits) {
    const id = Number(edit.id);
    const cutAmount = normalizeAmount(edit.cutAmount);
    const item = byId.get(id);

    if (!item) {
      return res.status(400).json({
        ok: false,
        message: 'มีรายการ Snapshot ที่ไม่ถูกต้อง'
      });
    }

    const snapshotAmount = Number(
      item.snapshot_amount || 0
    );

    if (
      cutAmount === null ||
      cutAmount < 0 ||
      cutAmount > snapshotAmount
    ) {
      return res.status(400).json({
        ok: false,
        message:
          `ยอดตีออกของ ${item.number_value} ต้องอยู่ระหว่าง 0 ถึง ${snapshotAmount}`
      });
    }

    normalized.push({
      id,
      cutAmount
    });
  }

  // ใช้ค่าปัจจุบันเดิมสำหรับแถวที่ไม่ได้ส่งมา
  const finalMap = new Map(
    currentItems.map(item => [
      Number(item.id),
      Number(item.cut_amount || 0)
    ])
  );

  for (const item of normalized) {
    finalMap.set(
      item.id,
      item.cutAmount
    );
  }

  // Prototype-safe finalize: validate all first, then persist every edited row,
  // then confirm once. Production hardening should wrap this in a DB transaction.
  for (const [id, cutAmount] of finalMap.entries()) {
    await sql`
      update exposure_cut_items
      set cut_amount = ${cutAmount}
      where id = ${id}
        and round_id = ${roundId}
    `;
  }

  const confirmedRows = await sql`
    update exposure_cut_rounds
    set
      status = 'CONFIRMED',
      confirmed_by = ${confirmedBy},
      confirmed_at = now()
    where id = ${roundId}
      and workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
      and status = 'DRAFT'
    returning *
  `;

  if (!confirmedRows.length) {
    return res.status(409).json({
      ok: false,
      message: 'ยืนยันรอบไม่สำเร็จ'
    });
  }

  return res.status(200).json({
    ok: true,
    message:
      `ตีออกและยืนยัน ${confirmedRows[0].round_code} แล้ว`,
    round: confirmedRows[0]
  });
}

async function listCutRounds(req, res) {
  await ensureExposureTables();

  const workspaceId = clean(req.query?.workspaceId);
  const drawCode = upper(req.query?.drawCode);

  if (!workspaceId || !drawCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Workspace/งวดไม่ครบ'
    });
  }

  const rounds = await sql`
    select
      r.*,
      coalesce(sum(i.cut_amount), 0)::numeric as total_cut,
      count(i.id)::integer as item_count
    from exposure_cut_rounds r
    left join exposure_cut_items i
      on i.round_id = r.id
    where r.workspace_id = ${workspaceId}
      and upper(r.draw_code) = ${drawCode}
    group by r.id
    order by r.round_no asc
  `;

  const items = await sql`
    select
      i.*,
      r.round_code,
      r.status as round_status
    from exposure_cut_items i
    join exposure_cut_rounds r
      on r.id = i.round_id
    where i.workspace_id = ${workspaceId}
      and upper(i.draw_code) = ${drawCode}
    order by r.round_no asc, i.bet_type asc, i.number_value asc
  `;

  return res.status(200).json({
    ok: true,
    rounds: rounds.map(row => ({
      id: Number(row.id),
      roundNo: Number(row.round_no),
      roundCode: row.round_code,
      status: row.status,
      totalCut: Number(row.total_cut || 0),
      itemCount: Number(row.item_count || 0),
      createdAt: row.created_at,
      confirmedAt: row.confirmed_at
    })),
    items: items.map(row => ({
      id: Number(row.id),
      roundId: Number(row.round_id),
      roundCode: row.round_code,
      roundStatus: row.round_status,
      betType: row.bet_type,
      numberValue: row.number_value,
      snapshotAmount: Number(row.snapshot_amount || 0),
      cutAmount: Number(row.cut_amount || 0),
      snapshotRemaining: Math.max(
        Number(row.snapshot_amount || 0)
        - Number(row.cut_amount || 0),
        0
      )
    }))
  });
}


const SETTINGS_CATEGORIES = [
  { key: '3_TOP', label: '3บน', defaultGroup: '3', digits: 3 },
  { key: '3_FRONT', label: '3หน้า', defaultGroup: '3', digits: 3 },
  { key: '3_BOTTOM', label: '3ล่าง', defaultGroup: 'ล', digits: 3 },
  { key: '2_TOP', label: '2บน', defaultGroup: '2', digits: 2 },
  { key: '2_BOTTOM', label: '2ล่าง', defaultGroup: '2', digits: 2 },
  { key: '2_FRONT', label: '2หน้า', defaultGroup: '2', digits: 2 },
  { key: 'RUN_TOP', label: 'วิ่งบน', defaultGroup: '1', digits: 1 },
  { key: 'RUN_BOTTOM', label: 'วิ่งล่าง', defaultGroup: '1', digits: 1 },
  { key: 'PAK_TOP', label: 'ปักหลักบน', defaultGroup: '1', digits: 1 },
  { key: 'PAK_BOTTOM', label: 'ปักหลักล่าง', defaultGroup: '1', digits: 1 },
  { key: 'TOOD_2', label: 'โต๊ด2', defaultGroup: 'ต', digits: 2 },
  { key: 'TOOD_3', label: 'โต๊ด3', defaultGroup: 'ต', digits: 3 },
  { key: 'TOOD_4', label: 'โต๊ด4', defaultGroup: '4', digits: 4 },
  { key: 'TOOD_5', label: 'โต๊ด5', defaultGroup: '4', digits: 5 }
];

async function ensureSettingsCoreTables() {
  await ensureExposureTables();

  await sql`
    create table if not exists shop_rate_settings (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      category_key text not null,
      discount_group_code text not null,
      discount_percent numeric(7,3) not null default 0,
      payout_rate numeric(14,3) not null default 0,
      is_enabled boolean not null default true,
      updated_by text,
      updated_at timestamptz not null default now(),
      unique(workspace_id, draw_code, category_key)
    )
  `;

  await sql`
    create index if not exists idx_shop_rate_settings_lookup
    on shop_rate_settings (
      workspace_id,
      draw_code,
      category_key,
      is_enabled
    )
  `;

  await sql`
    create table if not exists shop_core_preferences (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      input_mode text not null default 'SLIP_IMAGE',
      closed_accept_mode text not null default 'AUTO_MASTER_REVIEW',
      updated_by text,
      updated_at timestamptz not null default now(),
      unique(workspace_id, draw_code)
    )
  `;

  await sql`alter table slip_entries add column if not exists restriction_mode text not null default 'NONE'`;
  await sql`alter table slip_entries add column if not exists restriction_percent numeric(7,3) not null default 0`;
  await sql`alter table slip_entries add column if not exists restriction_label text`;
  await sql`alter table slip_entries add column if not exists closed_accept_status text`;
  await sql`alter table slip_entries add column if not exists closed_review_status text`;
  await sql`alter table slip_entries add column if not exists is_counted boolean not null default true`;
  await sql`alter table slip_entries add column if not exists restriction_snapshot_at timestamptz`;
  await sql`alter table slip_entries add column if not exists matched_closed_number_id bigint`;

  await sql`
    create table if not exists shop_closed_numbers (
      id bigserial primary key,
      workspace_id text not null,
      draw_code text not null,
      category_key text not null,
      number_value text not null,
      note text,
      is_active boolean not null default true,
      created_by text,
      created_at timestamptz not null default now(),
      unique(workspace_id, draw_code, category_key, number_value)
    )
  `;

  await sql`
    alter table shop_closed_numbers
    add column if not exists close_mode text not null default 'CLOSED'
  `;

  await sql`
    alter table shop_closed_numbers
    add column if not exists payout_percent numeric(7,3) not null default 0
  `;

  await sql`
    alter table shop_closed_numbers
    add column if not exists source_number text
  `;

  await sql`
    alter table shop_closed_numbers
    add column if not exists effective_time text
  `;

  await sql`
    alter table shop_closed_numbers
    add column if not exists effective_at timestamptz
  `;

  await sql`
    update shop_closed_numbers
    set effective_at = created_at
    where effective_at is null
  `;

  await sql`
    update shop_closed_numbers old
    set category_key = 'PAK_TOP'
    where old.category_key = 'PAK_LAK'
      and not exists (
        select 1 from shop_closed_numbers current
        where current.workspace_id = old.workspace_id
          and current.draw_code = old.draw_code
          and current.category_key = 'PAK_TOP'
          and current.number_value = old.number_value
      )
  `;

  await sql`
    update shop_closed_numbers
    set is_active = false
    where category_key = 'PAK_LAK'
  `;

  await sql`
    create index if not exists idx_shop_closed_numbers_lookup
    on shop_closed_numbers (
      workspace_id,
      draw_code,
      category_key,
      is_active,
      number_value
    )
  `;
}

async function listSettingsCore(req, res) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(req.query?.workspaceId);
  const drawCode = upper(req.query?.drawCode);

  if (!workspaceId || !drawCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Workspace/งวดไม่ครบ'
    });
  }

  const preferenceRows = await sql`
    select *
    from shop_core_preferences
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    limit 1
  `;

  const rateRows = await sql`
    select *
    from shop_rate_settings
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    order by category_key asc
  `;

  const limitRows = await sql`
    select *
    from exposure_type_limits
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
    order by category_key asc
  `;

  const closedRows = await sql`
    select *
    from shop_closed_numbers
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
      and is_active = true
    order by category_key asc, effective_at asc nulls last, number_value asc
  `;

  const rateMap = new Map(
    rateRows.map(row => [row.category_key, row])
  );

  const limitMap = new Map(
    limitRows.map(row => [row.category_key, row])
  );

  return res.status(200).json({
    ok: true,
    workspaceId,
    drawCode,
    workflowSettings: {
      inputMode: preferenceRows[0]?.input_mode || 'SLIP_IMAGE',
      closedAcceptMode: preferenceRows[0]?.closed_accept_mode || 'AUTO_MASTER_REVIEW',
      updatedAt: preferenceRows[0]?.updated_at || null
    },
    categories: SETTINGS_CATEGORIES.map(item => {
      const rate = rateMap.get(item.key);
      const limit = limitMap.get(item.key);

      return {
        categoryKey: item.key,
        label: item.label,
        defaultGroup: item.defaultGroup,
        digits: item.digits,
        discountGroupCode:
          rate?.discount_group_code || item.defaultGroup,
        discountPercent:
          Number(rate?.discount_percent || 0),
        payoutRate:
          Number(rate?.payout_rate || 0),
        rateEnabled:
          rate ? Boolean(rate.is_enabled) : true,
        limitAmount:
          Number(limit?.limit_amount || 0),
        limitEnabled:
          limit ? Boolean(limit.is_enabled) : false
      };
    }),
    closedNumbers: closedRows.map(row => ({
      id: Number(row.id),
      categoryKey: row.category_key,
      numberValue: row.number_value,
      note: row.note || '',
      closeMode: row.close_mode || 'CLOSED',
      payoutPercent: Number(row.payout_percent || 0),
      sourceNumber: row.source_number || row.number_value,
      effectiveAt: row.effective_at || row.created_at,
      createdAt: row.created_at
    }))
  });
}

async function saveCorePreferences(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const inputMode = upper(body.inputMode || 'SLIP_IMAGE');
  const closedAcceptMode = upper(body.closedAcceptMode || 'AUTO_MASTER_REVIEW');
  const updatedBy = upper(body.updatedBy || 'M');

  if (!workspaceId || !drawCode) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลรูปแบบการทำงานไม่ครบ' });
  }

  if (!['LABEL', 'SLIP_IMAGE'].includes(inputMode)) {
    return res.status(400).json({ ok: false, message: 'โหมดเลเบล/รูปโพยไม่ถูกต้อง' });
  }

  if (!['ASK_SUBKEY_AT_FINISH', 'AUTO_MASTER_REVIEW'].includes(closedAcceptMode)) {
    return res.status(400).json({ ok: false, message: 'วิธีรับเลขปิดไม่ถูกต้อง' });
  }

  const rows = await sql`
    insert into shop_core_preferences (
      workspace_id, draw_code, input_mode, closed_accept_mode, updated_by, updated_at
    ) values (
      ${workspaceId}, ${drawCode}, ${inputMode}, ${closedAcceptMode}, ${updatedBy}, now()
    )
    on conflict (workspace_id, draw_code)
    do update set
      input_mode = excluded.input_mode,
      closed_accept_mode = excluded.closed_accept_mode,
      updated_by = excluded.updated_by,
      updated_at = now()
    returning *
  `;

  return res.status(200).json({
    ok: true,
    message: 'บันทึกรูปแบบการทำงานแล้ว',
    setting: rows[0]
  });
}

async function saveRateSetting(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const categoryKey = upper(body.categoryKey);
  const discountGroupCode = clean(body.discountGroupCode);
  const discountPercent = Number(body.discountPercent);
  const payoutRate = Number(body.payoutRate);
  const isEnabled = body.isEnabled !== false;
  const updatedBy = upper(body.updatedBy || 'M');

  if (
    !workspaceId ||
    !drawCode ||
    !categoryKey ||
    !discountGroupCode
  ) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลเรตไม่ครบ'
    });
  }

  if (
    !Number.isFinite(discountPercent) ||
    discountPercent < 0 ||
    discountPercent > 100
  ) {
    return res.status(400).json({
      ok: false,
      message: 'เปอร์เซ็นต์ลดต้องอยู่ระหว่าง 0-100'
    });
  }

  if (!Number.isFinite(payoutRate) || payoutRate < 0) {
    return res.status(400).json({
      ok: false,
      message: 'อัตราจ่ายไม่ถูกต้อง'
    });
  }

  const rows = await sql`
    insert into shop_rate_settings (
      workspace_id,
      draw_code,
      category_key,
      discount_group_code,
      discount_percent,
      payout_rate,
      is_enabled,
      updated_by,
      updated_at
    )
    values (
      ${workspaceId},
      ${drawCode},
      ${categoryKey},
      ${discountGroupCode},
      ${discountPercent},
      ${payoutRate},
      ${isEnabled},
      ${updatedBy},
      now()
    )
    on conflict (
      workspace_id,
      draw_code,
      category_key
    )
    do update set
      discount_group_code = excluded.discount_group_code,
      discount_percent = excluded.discount_percent,
      payout_rate = excluded.payout_rate,
      is_enabled = excluded.is_enabled,
      updated_by = excluded.updated_by,
      updated_at = now()
    returning *
  `;

  return res.status(200).json({
    ok: true,
    message: 'บันทึกส่วนลด/อัตราจ่ายแล้ว',
    setting: rows[0]
  });
}

async function bulkSaveRateSettings(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const updatedBy = upper(body.updatedBy || 'M');
  const items = Array.isArray(body.items) ? body.items : [];

  if (!workspaceId || !drawCode || !items.length) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลบันทึกเรตรวมไม่ครบ' });
  }

  const saved = [];
  for (const item of items) {
    const categoryKey = upper(item.categoryKey);
    const discountGroupCode = clean(item.discountGroupCode);
    const discountPercent = Number(item.discountPercent);
    const payoutRate = Number(item.payoutRate);
    const isEnabled = item.isEnabled !== false;

    if (!categoryKey || !discountGroupCode) {
      return res.status(400).json({ ok: false, message: 'มีประเภทหรือกลุ่มสรุปไม่ครบในรายการรวม' });
    }

    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      return res.status(400).json({ ok: false, message: `เปอร์เซ็นต์ลดของ ${categoryKey} ไม่ถูกต้อง` });
    }

    if (!Number.isFinite(payoutRate) || payoutRate < 0) {
      return res.status(400).json({ ok: false, message: `อัตราจ่ายของ ${categoryKey} ไม่ถูกต้อง` });
    }

    const rows = await sql`
      insert into shop_rate_settings (
        workspace_id,
        draw_code,
        category_key,
        discount_group_code,
        discount_percent,
        payout_rate,
        is_enabled,
        updated_by,
        updated_at
      )
      values (
        ${workspaceId},
        ${drawCode},
        ${categoryKey},
        ${discountGroupCode},
        ${discountPercent},
        ${payoutRate},
        ${isEnabled},
        ${updatedBy},
        now()
      )
      on conflict (workspace_id, draw_code, category_key)
      do update set
        discount_group_code = excluded.discount_group_code,
        discount_percent = excluded.discount_percent,
        payout_rate = excluded.payout_rate,
        is_enabled = excluded.is_enabled,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning *
    `;

    saved.push(rows[0]);
  }

  return res.status(200).json({
    ok: true,
    message: `บันทึกส่วนลด/อัตราจ่ายรวม ${saved.length} ประเภทแล้ว`,
    count: saved.length
  });
}

async function bulkSetExposureTypeLimits(res, body) {
  await ensureExposureTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const updatedBy = upper(body.updatedBy || 'M');
  const items = Array.isArray(body.items) ? body.items : [];

  if (!workspaceId || !drawCode || !items.length) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลบันทึกอั้นรวมไม่ครบ' });
  }

  const saved = [];
  for (const item of items) {
    const categoryKey = upper(item.categoryKey);
    const limitAmount = normalizeAmount(item.limitAmount);
    const isEnabled = item.isEnabled !== false;

    if (!categoryKey) {
      return res.status(400).json({ ok: false, message: 'มีประเภทยอดอั้นไม่ครบในรายการรวม' });
    }

    if (limitAmount === null || limitAmount < 0) {
      return res.status(400).json({ ok: false, message: `ยอดอั้นของ ${categoryKey} ไม่ถูกต้อง` });
    }

    const rows = await sql`
      insert into exposure_type_limits (
        workspace_id,
        draw_code,
        category_key,
        limit_amount,
        is_enabled,
        updated_by,
        updated_at
      )
      values (
        ${workspaceId},
        ${drawCode},
        ${categoryKey},
        ${limitAmount},
        ${isEnabled},
        ${updatedBy},
        now()
      )
      on conflict (workspace_id, draw_code, category_key)
      do update set
        limit_amount = excluded.limit_amount,
        is_enabled = excluded.is_enabled,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning *
    `;

    saved.push(rows[0]);
  }

  return res.status(200).json({
    ok: true,
    message: `บันทึกอั้นรวม ${saved.length} ประเภทแล้ว`,
    count: saved.length
  });
}

async function saveClosedNumbers(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const categoryKeys = Array.isArray(body.categoryKeys)
    ? [...new Set(body.categoryKeys.map(upper).filter(Boolean))]
    : [];
  const numbers = Array.isArray(body.numbers)
    ? [...new Set(body.numbers.map(clean).filter(Boolean))]
    : [];
  const sourceNumbers = Array.isArray(body.sourceNumbers)
    ? [...new Set(body.sourceNumbers.map(clean).filter(Boolean))]
    : [];
  const closeMode = upper(body.closeMode || 'CLOSED');
  const payoutPercent = closeMode === 'CLOSED' ? 0 : Number(body.payoutPercent);
  const note = clean(body.note);
  const createdBy = upper(body.createdBy || 'M');

  if (!workspaceId || !drawCode || !categoryKeys.length || !numbers.length) {
    return res.status(400).json({ ok: false, message: 'ข้อมูลเลขปิด / จ่าย % ไม่ครบ' });
  }

  if (!['CLOSED', 'PAYOUT_PERCENT'].includes(closeMode)) {
    return res.status(400).json({ ok: false, message: 'สถานะรายการไม่ถูกต้อง' });
  }

  if (closeMode === 'PAYOUT_PERCENT' && (
    !Number.isFinite(payoutPercent) || payoutPercent <= 0 || payoutPercent > 100
  )) {
    return res.status(400).json({ ok: false, message: 'จ่าย % ต้องมากกว่า 0 และไม่เกิน 100' });
  }

  if (numbers.length > 500) {
    return res.status(400).json({ ok: false, message: 'จำนวนเลขหลังขยายมากเกินไป' });
  }

  const categoryMap = new Map(SETTINGS_CATEGORIES.map(item => [item.key, item]));
  for (const key of categoryKeys) {
    if (!categoryMap.has(key)) {
      return res.status(400).json({ ok: false, message: `ไม่พบประเภท ${key}` });
    }
  }

  for (const numberValue of numbers) {
    if (!/^[0-9]{1,5}$/.test(numberValue)) {
      return res.status(400).json({ ok: false, message: 'มีเลขไม่ถูกต้องในชุดรายการ' });
    }
  }

  for (const key of categoryKeys) {
    const digits = categoryMap.get(key).digits;
    if (numbers.some(numberValue => numberValue.length !== digits)) {
      return res.status(400).json({
        ok: false,
        message: `จำนวนหลักไม่ตรงกับประเภท ${categoryMap.get(key).label}`
      });
    }
  }

  const rows = [];
  const sourceNumber = sourceNumbers.join('/') || numbers.join('/');
  const clockRows = await sql`select now() as effective_at`;
  const effectiveAt = clockRows[0].effective_at;

  for (const categoryKey of categoryKeys) {
    for (const numberValue of numbers) {
      const saved = await sql`
        insert into shop_closed_numbers (
          workspace_id, draw_code, category_key, number_value, note,
          is_active, created_by, created_at, close_mode, payout_percent, source_number, effective_at
        )
        values (
          ${workspaceId}, ${drawCode}, ${categoryKey}, ${numberValue}, ${note || null},
          true, ${createdBy}, ${effectiveAt}, ${closeMode}, ${payoutPercent}, ${sourceNumber}, ${effectiveAt}
        )
        on conflict (workspace_id, draw_code, category_key, number_value)
        do update set
          note = excluded.note,
          is_active = true,
          close_mode = excluded.close_mode,
          payout_percent = excluded.payout_percent,
          source_number = excluded.source_number,
          effective_at = excluded.effective_at,
          created_by = excluded.created_by,
          created_at = excluded.created_at
        returning *
      `;
      rows.push(saved[0]);
    }
  }

  return res.status(200).json({
    ok: true,
    message: `บันทึก ${rows.length} รายการแล้ว`,
    count: rows.length
  });
}

async function prepareSlipCompletion(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const slipId = clean(body.slipId);
  const subkeyCode = upper(body.subkeyCode);
  const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : {};

  if (!workspaceId || !drawCode || !slipId || !subkeyCode) {
    return res.status(400).json({ ok:false, message:'ข้อมูลเตรียมจบโพยไม่ครบ' });
  }

  const holder = await verifySlipHolder({ workspaceId, drawCode, slipId, subkeyCode });
  if (!holder.ok) return res.status(holder.status).json({ ok:false, message:holder.message });

  const preferenceRows = await sql`
    select input_mode, closed_accept_mode
    from shop_core_preferences
    where workspace_id=${workspaceId} and upper(draw_code)=${drawCode}
    limit 1
  `;
  const closedAcceptMode = preferenceRows[0]?.closed_accept_mode || 'AUTO_MASTER_REVIEW';

  const entryRows = await sql`
    select * from slip_entries
    where workspace_id=${workspaceId} and upper(draw_code)=${drawCode} and slip_id=${slipId}
    order by entry_seq asc, id asc
  `;

  const referenceAt = holder.slip.received_at || holder.slip.claimed_at || new Date().toISOString();
  const closedRows = await sql`
    select * from shop_closed_numbers
    where workspace_id=${workspaceId}
      and upper(draw_code)=${drawCode}
      and is_active=true
      and coalesce(effective_at, created_at) <= ${referenceAt}
    order by coalesce(effective_at, created_at) desc, id desc
  `;

  const matches = [];
  const plans = [];
  for (const row of entryRows) {
    const categoryKey = exposureCategoryKey(row.number_value, row.bet_type);
    const matched = closedRows.find(item => item.category_key === categoryKey && item.number_value === row.number_value);
    if (!matched) {
      plans.push({ id:Number(row.id), mode:'NONE', percent:0, label:'', accept:'NOT_APPLICABLE', review:'NOT_APPLICABLE', counted:true, matchedId:null });
      continue;
    }
    if ((matched.close_mode || 'CLOSED') === 'PAYOUT_PERCENT') {
      const percent = Number(matched.payout_percent || 0);
      plans.push({ id:Number(row.id), mode:'PAYOUT_PERCENT', percent, label:`(จ่าย ${percent}%)`, accept:'AUTO_ACCEPTED', review:'NOT_APPLICABLE', counted:true, matchedId:Number(matched.id) });
      continue;
    }

    matches.push({
      entryId:Number(row.id), numberValue:row.number_value, betType:row.bet_type,
      amount:Number(row.amount), label:'(ปิด)', categoryKey
    });

    let decision = closedAcceptMode === 'AUTO_MASTER_REVIEW' ? 'ACCEPT' : upper(decisions[String(row.id)] || decisions[row.id]);
    if (closedAcceptMode === 'ASK_SUBKEY_AT_FINISH' && !['ACCEPT','REJECT'].includes(decision)) {
      continue;
    }
    const accepted = decision === 'ACCEPT';
    plans.push({ id:Number(row.id), mode:'CLOSED', percent:0, label:'(ปิด)', accept:accepted?'ACCEPTED':'REJECTED', review:accepted?'REVIEW_IF_WIN':'NOT_APPLICABLE', counted:accepted, matchedId:Number(matched.id) });
  }

  if (closedAcceptMode === 'ASK_SUBKEY_AT_FINISH') {
    const unresolved = matches.filter(item => !['ACCEPT','REJECT'].includes(upper(decisions[String(item.entryId)] || decisions[item.entryId])));
    if (unresolved.length) {
      return res.status(200).json({
        ok:true, ready:false, requiresDecision:true, closedAcceptMode,
        referenceAt, items:unresolved,
        message:'พบเลขปิด กรุณาเลือก รับ/ไม่รับ ใน Popup เดียว'
      });
    }
  }

  for (const plan of plans) {
    await sql`
      update slip_entries set
        restriction_mode=${plan.mode},
        restriction_percent=${plan.percent},
        restriction_label=${plan.label || null},
        closed_accept_status=${plan.accept},
        closed_review_status=${plan.review},
        is_counted=${plan.counted},
        matched_closed_number_id=${plan.matchedId},
        restriction_snapshot_at=now(),
        updated_at=now()
      where id=${plan.id} and workspace_id=${workspaceId} and slip_id=${slipId}
    `;
  }

  return res.status(200).json({
    ok:true, ready:true, requiresDecision:false, closedAcceptMode,
    acceptedClosed:plans.filter(x=>x.mode==='CLOSED'&&x.counted).length,
    rejectedClosed:plans.filter(x=>x.mode==='CLOSED'&&!x.counted).length,
    payoutPercent:plans.filter(x=>x.mode==='PAYOUT_PERCENT').length,
    message:'ตรวจและ Snapshot เลขปิด / จ่าย % แล้ว'
  });
}

async function deleteClosedNumber(res, body) {
  await ensureSettingsCoreTables();

  const workspaceId = clean(body.workspaceId);
  const drawCode = upper(body.drawCode);
  const id = Number(body.id);

  if (!workspaceId || !drawCode || !id) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูลลบเลขปิดไม่ครบ'
    });
  }

  const rows = await sql`
    update shop_closed_numbers
    set is_active = false
    where id = ${id}
      and workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
      and is_active = true
    returning *
  `;

  if (!rows.length) {
    return res.status(404).json({
      ok: false,
      message: 'ไม่พบเลขปิด'
    });
  }

  return res.status(200).json({
    ok: true,
    message: 'ยกเลิกเลขปิดแล้ว'
  });
}

async function listExposureIndex(req, res) {
  await ensureExposureTables();

  const workspaceId = clean(req.query?.workspaceId);
  const drawCode = upper(req.query?.drawCode);

  if (!workspaceId || !drawCode) {
    return res.status(400).json({
      ok: false,
      message: 'ข้อมูล Workspace/งวดไม่ครบ'
    });
  }

  const baseRows = await sql`
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
      and coalesce(e.is_counted, true) = true
    group by
      e.bet_type,
      e.number_value
  `;

  const limitRows = await sql`
    select
      category_key,
      limit_amount,
      is_enabled
    from exposure_type_limits
    where workspace_id = ${workspaceId}
      and upper(draw_code) = ${drawCode}
  `;

  const cutRows = await sql`
    with legacy as (
      select
        bet_type,
        number_value,
        coalesce(sum(amount), 0)::numeric as cut_amount
      from exposure_adjustments
      where workspace_id = ${workspaceId}
        and upper(draw_code) = ${drawCode}
        and adjustment_type = 'CUT'
        and status = 'CONFIRMED'
      group by bet_type, number_value
    ),
    rounds as (
      select
        i.bet_type,
        i.number_value,
        coalesce(sum(i.cut_amount), 0)::numeric as cut_amount
      from exposure_cut_items i
      join exposure_cut_rounds r
        on r.id = i.round_id
      where i.workspace_id = ${workspaceId}
        and upper(i.draw_code) = ${drawCode}
        and r.status = 'CONFIRMED'
      group by i.bet_type, i.number_value
    ),
    keys as (
      select bet_type, number_value from legacy
      union
      select bet_type, number_value from rounds
    )
    select
      k.bet_type,
      k.number_value,
      coalesce(l.cut_amount, 0)
      + coalesce(r.cut_amount, 0) as cut_amount
    from keys k
    left join legacy l
      on l.bet_type = k.bet_type
     and l.number_value = k.number_value
    left join rounds r
      on r.bet_type = k.bet_type
     and r.number_value = k.number_value
  `;

  const limitMap = new Map(
    limitRows.map(row => [
      row.category_key,
      {
        amount: Number(row.limit_amount || 0),
        enabled: Boolean(row.is_enabled)
      }
    ])
  );

  const cutMap = new Map(
    cutRows.map(row => [
      `${row.bet_type}|||${row.number_value}`,
      Number(row.cut_amount || 0)
    ])
  );

  const items = baseRows.map(row => {
    const grossAmount = Number(row.gross_amount || 0);
    const categoryKey = exposureCategoryKey(
      row.number_value,
      row.bet_type
    );

    const categoryLimit = limitMap.get(categoryKey);
    const limitAmount =
      categoryLimit?.enabled
        ? Number(categoryLimit.amount || 0)
        : 0;

    const cutAmount =
      cutMap.get(
        `${row.bet_type}|||${row.number_value}`
      ) || 0;

    const currentBalance = Math.max(
      grossAmount -
      limitAmount -
      cutAmount,
      0
    );

    return {
      betType: row.bet_type,
      numberValue: row.number_value,
      categoryKey,
      entryCount: Number(row.entry_count || 0),
      slipCount: Number(row.slip_count || 0),
      grossAmount,
      limitAmount,
      cutAmount,
      currentBalance
    };
  }).sort((a, b) =>
    a.categoryKey.localeCompare(b.categoryKey) ||
    b.currentBalance - a.currentBalance ||
    b.grossAmount - a.grossAmount ||
    a.numberValue.localeCompare(b.numberValue)
  );

  const summary = items.reduce((acc, item) => {
    acc.entryCount += item.entryCount;
    acc.grossAmount += item.grossAmount;
    acc.limitAmount += Math.min(
      item.limitAmount,
      item.grossAmount
    );
    acc.cutAmount += item.cutAmount;
    acc.currentBalance += item.currentBalance;
    return acc;
  }, {
    slipCount: 0,
    entryCount: 0,
    grossAmount: 0,
    limitAmount: 0,
    cutAmount: 0,
    currentBalance: 0
  });

  const slipRows = await sql`
    select count(distinct e.slip_id)::integer as slip_count
    from slip_entries e
    join intake_slips s
      on s.workspace_id = e.workspace_id
     and s.slip_id = e.slip_id
    where e.workspace_id = ${workspaceId}
      and upper(coalesce(e.draw_code, '')) = ${drawCode}
      and s.queue_status = 'COMPLETED'
      and coalesce(e.is_counted, true) = true
  `;

  summary.slipCount = Number(
    slipRows[0]?.slip_count || 0
  );

  return res.status(200).json({
    ok: true,
    sourceOfTruth:
      'COMPLETED_SLIP_ENTRIES_PLUS_TYPE_LIMITS_PLUS_CONFIRMED_CUTS',
    workspaceId,
    drawCode,
    items,
    limits: limitRows.map(row => ({
      categoryKey: row.category_key,
      limitAmount: Number(row.limit_amount || 0),
      isEnabled: Boolean(row.is_enabled)
    })),
    summary
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

  const totalAmount = rows.reduce((sum, row) => sum + (row.is_counted === false ? 0 : Number(row.amount || 0)), 0);
  const excludedAmount = rows.reduce((sum, row) => sum + (row.is_counted === false ? Number(row.amount || 0) : 0), 0);

  return res.status(200).json({
    ok: true,
    displayOrder: 'LATEST_FIRST',
    entries: rows.map(mapEntry),
    summary: {
      count: rows.length,
      totalAmount,
      excludedAmount
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

      if (mode === 'EXPOSURE_LIMITS') {
        return await listExposureTypeLimits(req, res);
      }

      if (mode === 'CUT_ROUNDS') {
        return await listCutRounds(req, res);
      }

      if (mode === 'SETTINGS_CORE') {
        return await listSettingsCore(req, res);
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

      if (action === 'EXPOSURE_ADJUST') {
        return await addExposureAdjustment(res, body);
      }

      if (action === 'SAVE_CORE_PREFERENCES') {
        return await saveCorePreferences(res, body);
      }

      if (action === 'SET_EXPOSURE_TYPE_LIMIT') {
        return await upsertExposureTypeLimit(res, body);
      }

      if (action === 'BULK_SET_EXPOSURE_TYPE_LIMITS') {
        return await bulkSetExposureTypeLimits(res, body);
      }

      if (action === 'CREATE_CUT_ROUND') {
        return await createCutRound(res, body);
      }

      if (action === 'UPSERT_CUT_ROUND_ITEM') {
        return await upsertCutRoundItem(res, body);
      }

      if (action === 'CONFIRM_CUT_ROUND') {
        return await confirmCutRound(res, body);
      }

      if (action === 'FINALIZE_CUT_ROUND') {
        return await finalizeCutRound(res, body);
      }

      if (action === 'SAVE_RATE_SETTING') {
        return await saveRateSetting(res, body);
      }

      if (action === 'BULK_SAVE_RATE_SETTINGS') {
        return await bulkSaveRateSettings(res, body);
      }

      if (action === 'SAVE_CLOSED_NUMBERS') {
        return await saveClosedNumbers(res, body);
      }

      if (action === 'PREPARE_SLIP_COMPLETION') {
        return await prepareSlipCompletion(res, body);
      }

      if (action === 'DELETE_CLOSED_NUMBER') {
        return await deleteClosedNumber(res, body);
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
