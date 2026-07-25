import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

async function ensureCompletionSnapshotColumns() {
  await sql`alter table slip_entries add column if not exists restriction_snapshot_at timestamptz`;
  await sql`alter table slip_entries add column if not exists is_counted boolean not null default true`;
}

function mapSlip(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slipId: row.slip_id,
    fileId: row.file_id,
    sourceFilename: row.source_filename,
    agentCode: row.agent_code,
    drawCode: row.draw_code || '',
    queueStatus: row.queue_status,
    assignedSubkey: row.assigned_subkey || '',
    receivedAt: row.received_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at
  };
}

export default async function handler(req, res) {
  try {

    // =========================================================
    // GET : ดู Queue
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
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at

          from intake_slips

          where workspace_id = ${workspaceId}

            and upper(
              coalesce(
                draw_code,
                ''
              )
            ) = ${drawCode}

          order by
            received_at asc,
            id asc

          limit 500
        `;

      } else {

        rows = await sql`
          select
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at

          from intake_slips

          where workspace_id = ${workspaceId}

          order by
            received_at asc,
            id asc

          limit 500
        `;
      }

      const waiting =
        rows.filter(
          row =>
            row.queue_status === 'WAITING'
        );

      const inProgress =
        rows.filter(
          row =>
            row.queue_status === 'IN_PROGRESS'
        );

      const completed =
        rows.filter(
          row =>
            row.queue_status === 'COMPLETED'
        );

      return res.status(200).json({
        ok: true,

        counts: {
          total: rows.length,
          waiting: waiting.length,
          inProgress: inProgress.length,
          completed: completed.length
        },

        queue:
          rows.map(mapSlip)
      });
    }


    // =========================================================
    // POST
    // =========================================================
    if (req.method === 'POST') {

      const {
        action,
        workspaceId,
        drawCode,
        subkeyCode,
        slipId
      } = req.body || {};


      const command =
        upper(action);

      const workspace =
        clean(workspaceId);

      const draw =
        upper(drawCode);

      const subkey =
        upper(subkeyCode);

      const targetSlipId =
        clean(slipId);


      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }


      // =======================================================
      // CLAIM_NEXT
      // =======================================================
      if (command === 'CLAIM_NEXT') {

        if (!draw) {
          return res.status(400).json({
            ok: false,
            message: 'กรุณาเลือกงวด'
          });
        }

        if (!subkey) {
          return res.status(400).json({
            ok: false,
            message: 'ไม่พบรหัส Subkey'
          });
        }


        // -----------------------------------------------------
        // ตรวจ Workspace
        // -----------------------------------------------------
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
            message:
              'Workspace นี้ถูกปิดใช้งาน'
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


        // -----------------------------------------------------
        // ตรวจงวด
        // -----------------------------------------------------
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
            message:
              'ไม่พบงวดนี้'
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


        // =====================================================
        // ATOMIC CLAIM
        // =====================================================
        const result = await sql`

          with lock_guard as materialized (

            select
              pg_advisory_xact_lock(
                hashtextextended(
                  ${workspace + '|' + draw + '|' + subkey},
                  0
                )
              ) as locked

          ),

          existing_job as materialized (

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
              s.completed_at

            from intake_slips s

            cross join lock_guard

            where s.workspace_id = ${workspace}

              and upper(
                coalesce(
                  s.draw_code,
                  ''
                )
              ) = ${draw}

              and s.queue_status =
                'IN_PROGRESS'

              and upper(
                coalesce(
                  s.assigned_subkey,
                  ''
                )
              ) = ${subkey}

            order by
              s.claimed_at asc nulls last,
              s.received_at asc,
              s.id asc

            limit 1
          ),

          next_slip as materialized (

            select
              s.id

            from intake_slips s

            cross join lock_guard

            where s.workspace_id = ${workspace}

              and upper(
                coalesce(
                  s.draw_code,
                  ''
                )
              ) = ${draw}

              and s.queue_status =
                'WAITING'

              and not exists (
                select 1
                from existing_job
              )

            order by
              s.received_at asc,
              s.id asc

            for update of s
            skip locked

            limit 1
          ),

          claimed_job as (

            update intake_slips

            set
              queue_status =
                'IN_PROGRESS',

              assigned_subkey =
                ${subkey},

              claimed_at =
                now(),

              updated_at =
                now()

            where id = (
              select id
              from next_slip
            )

              and queue_status =
                'WAITING'

            returning
              id,
              workspace_id,
              slip_id,
              file_id,
              source_filename,
              agent_code,
              draw_code,
              queue_status,
              assigned_subkey,
              received_at,
              claimed_at,
              completed_at
          )

          select
            'RESUMED' as result_type,

            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at

          from existing_job


          union all


          select
            'CLAIMED' as result_type,

            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at

          from claimed_job

          limit 1
        `;


        if (!result.length) {

          return res.status(200).json({
            ok: true,

            empty: true,

            resumed: false,

            message:
              'ไม่มีโพย WAITING ในงวดนี้'
          });
        }


        const row =
          result[0];


        const resumed =
          row.result_type ===
          'RESUMED';


        return res.status(200).json({
          ok: true,

          empty: false,

          resumed,

          message:
            resumed
              ? 'พบงานเดิมที่ Subkey กำลังถืออยู่'
              : 'รับงานจาก Queue สำเร็จ',

          slip:
            mapSlip(row)
        });
      }


      // =======================================================
      // COMPLETE
      // S จบใบ
      //
      // IN_PROGRESS -> COMPLETED
      //
      // สำคัญ:
      // - เก็บ assigned_subkey ไว้เป็นประวัติว่าใครคีย์
      // - เก็บ claimed_at เดิม
      // - บันทึก completed_at
      // - S จะไม่มี IN_PROGRESS แล้ว จึงรับใบถัดไปได้
      // =======================================================
      if (command === 'COMPLETE') {

        if (!targetSlipId) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบ Slip ID'
          });
        }


        if (!draw) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบงวด'
          });
        }


        if (!subkey) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบรหัส Subkey'
          });
        }


        await ensureCompletionSnapshotColumns();

        const entryState = await sql`
          select
            count(*)::integer as total_count,
            count(*) filter (where restriction_snapshot_at is null)::integer as pending_count
          from slip_entries
          where workspace_id=${workspace}
            and upper(coalesce(draw_code,''))=${draw}
            and slip_id=${targetSlipId}
        `;

        if (Number(entryState[0]?.pending_count || 0) > 0) {
          return res.status(409).json({
            ok:false,
            message:'ยังไม่ได้ตรวจและ Snapshot เลขปิด / จ่าย % ก่อนจบใบ'
          });
        }

        const completed = await sql`
          update intake_slips

          set
            queue_status =
              'COMPLETED',

            completed_at =
              now(),

            updated_at =
              now()

          where workspace_id =
            ${workspace}

            and slip_id =
              ${targetSlipId}

            and upper(
              coalesce(
                draw_code,
                ''
              )
            ) = ${draw}

            and queue_status =
              'IN_PROGRESS'

            and upper(
              coalesce(
                assigned_subkey,
                ''
              )
            ) = ${subkey}

          returning
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            draw_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at,
            completed_at
        `;


        if (!completed.length) {

          return res.status(409).json({
            ok: false,

            message:
              'ไม่สามารถจบใบนี้ได้ หรือโพยไม่ได้อยู่กับ Subkey/งวดนี้'
          });
        }


        return res.status(200).json({
          ok: true,

          message:
            'จบใบสำเร็จ',

          slip:
            mapSlip(
              completed[0]
            )
        });
      }


      // =======================================================
      // RELEASE
      // =======================================================
      if (command === 'RELEASE') {

        if (!targetSlipId) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบ Slip ID'
          });
        }


        if (!draw) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบงวด'
          });
        }


        if (!subkey) {
          return res.status(400).json({
            ok: false,
            message:
              'ไม่พบรหัส Subkey'
          });
        }


        const released = await sql`
          update intake_slips

          set
            queue_status = 'WAITING',

            assigned_subkey = null,

            claimed_at = null,

            updated_at = now()

          where workspace_id =
            ${workspace}

            and slip_id =
              ${targetSlipId}

            and upper(
              coalesce(
                draw_code,
                ''
              )
            ) = ${draw}

            and queue_status =
              'IN_PROGRESS'

            and upper(
              coalesce(
                assigned_subkey,
                ''
              )
            ) = ${subkey}

          returning
            id,
            slip_id,
            draw_code,
            queue_status
        `;


        if (!released.length) {

          return res.status(409).json({
            ok: false,

            message:
              'ไม่สามารถคืนโพยนี้ได้ หรือโพยไม่ได้อยู่กับ Subkey/งวดนี้'
          });
        }


        return res.status(200).json({
          ok: true,

          message:
            'คืนโพยกลับ Queue แล้ว',

          slipId:
            released[0].slip_id,

          drawCode:
            released[0].draw_code,

          queueStatus:
            released[0].queue_status
        });
      }


      return res.status(400).json({
        ok: false,
        message:
          'Action ไม่ถูกต้อง'
      });
    }


    return res.status(405).json({
      ok: false,
      message:
        'Method not allowed'
    });

  } catch (error) {

    console.error(
      'queue api error:',
      error
    );


    if (error?.code === '23505') {

      return res.status(409).json({
        ok: false,

        message:
          'Subkey นี้มีงาน IN_PROGRESS อยู่แล้ว กรุณาเปิดงานเดิมก่อน'
      });
    }


    return res.status(500).json({
      ok: false,

      message:
        'ระบบ Queue เกิดข้อผิดพลาด'
    });
  }
}
