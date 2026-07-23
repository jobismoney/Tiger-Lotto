import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

function clean(value) {
  return String(value || '').trim();
}

export default async function handler(req, res) {
  try {

    // =========================================================
    // GET : ดูสถานะคิวของ Workspace
    // =========================================================
    if (req.method === 'GET') {

      const workspaceId =
        clean(req.query?.workspaceId);

      if (!workspaceId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      const rows = await sql`
        select
          id,
          workspace_id,
          slip_id,
          file_id,
          source_filename,
          agent_code,
          queue_status,
          assigned_subkey,
          received_at,
          claimed_at,
          completed_at
        from intake_slips
        where workspace_id = ${workspaceId}
        order by received_at asc, id asc
        limit 500
      `;

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

        queue: rows.map(row => ({
          id: row.id,
          workspaceId: row.workspace_id,
          slipId: row.slip_id,
          fileId: row.file_id,
          sourceFilename: row.source_filename,
          agentCode: row.agent_code,
          queueStatus: row.queue_status,
          assignedSubkey:
            row.assigned_subkey || '',
          receivedAt: row.received_at,
          claimedAt: row.claimed_at,
          completedAt: row.completed_at
        }))
      });
    }


    // =========================================================
    // POST : S ขอรับงานถัดไปจากกองกลาง
    // =========================================================
    if (req.method === 'POST') {

      const {
        action,
        workspaceId,
        subkeyCode,
        slipId
      } = req.body || {};

      const workspace =
        clean(workspaceId);

      const subkey =
        clean(subkeyCode)
          .toUpperCase();

      const command =
        clean(action)
          .toUpperCase();


      if (!workspace) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }


      // ---------------------------------------------------------
      // CLAIM_NEXT
      // S ขอรับโพย WAITING ตัวแรกตามเวลาที่ R รับเข้า
      // ใช้ FOR UPDATE SKIP LOCKED ป้องกันสอง S หยิบใบเดียวกัน
      // ---------------------------------------------------------
      if (command === 'CLAIM_NEXT') {

        if (!subkey) {
          return res.status(400).json({
            ok: false,
            message: 'ไม่พบรหัส Subkey'
          });
        }

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


        const claimed = await sql`
          with next_slip as (

            select id

            from intake_slips

            where workspace_id = ${workspace}

              and queue_status = 'WAITING'

            order by
              received_at asc,
              id asc

            for update skip locked

            limit 1
          )

          update intake_slips

          set
            queue_status = 'IN_PROGRESS',
            assigned_subkey = ${subkey},
            claimed_at = now(),
            updated_at = now()

          where id = (
            select id
            from next_slip
          )

            and queue_status = 'WAITING'

          returning
            id,
            workspace_id,
            slip_id,
            file_id,
            source_filename,
            agent_code,
            queue_status,
            assigned_subkey,
            received_at,
            claimed_at
        `;


        if (!claimed.length) {
          return res.status(200).json({
            ok: true,
            empty: true,
            message:
              'ไม่มีโพย WAITING ในคิว'
          });
        }


        const row =
          claimed[0];

        return res.status(200).json({
          ok: true,
          empty: false,
          message:
            'รับงานจาก Queue สำเร็จ',

          slip: {
            id: row.id,
            workspaceId:
              row.workspace_id,
            slipId:
              row.slip_id,
            fileId:
              row.file_id,
            sourceFilename:
              row.source_filename,
            agentCode:
              row.agent_code,
            queueStatus:
              row.queue_status,
            assignedSubkey:
              row.assigned_subkey,
            receivedAt:
              row.received_at,
            claimedAt:
              row.claimed_at
          }
        });
      }


      // ---------------------------------------------------------
      // RELEASE
      // คืนโพยกลับกองกลาง
      // ใช้กรณี S กดคืนงานก่อนคีย์เสร็จ
      // ---------------------------------------------------------
      if (command === 'RELEASE') {

        const targetSlipId =
          clean(slipId);

        if (!targetSlipId) {
          return res.status(400).json({
            ok: false,
            message: 'ไม่พบ Slip ID'
          });
        }

        if (!subkey) {
          return res.status(400).json({
            ok: false,
            message: 'ไม่พบรหัส Subkey'
          });
        }


        const released = await sql`
          update intake_slips

          set
            queue_status = 'WAITING',
            assigned_subkey = null,
            claimed_at = null,
            updated_at = now()

          where workspace_id = ${workspace}

            and slip_id = ${targetSlipId}

            and queue_status = 'IN_PROGRESS'

            and upper(
              coalesce(
                assigned_subkey,
                ''
              )
            ) = ${subkey}

          returning
            id,
            slip_id,
            queue_status
        `;


        if (!released.length) {
          return res.status(409).json({
            ok: false,
            message:
              'ไม่สามารถคืนโพยนี้ได้ หรือโพยไม่ได้อยู่กับ Subkey นี้'
          });
        }


        return res.status(200).json({
          ok: true,
          message:
            'คืนโพยกลับ Queue แล้ว',
          slipId:
            released[0].slip_id,
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
      message: 'Method not allowed'
    });

  }
  catch (error) {

    console.error(
      'queue api error:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'ระบบ Queue เกิดข้อผิดพลาด'
    });
  }
}
