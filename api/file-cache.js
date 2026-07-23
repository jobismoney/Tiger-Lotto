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

    // =========================================================
    // GET
    // เช็กสถานะรูป + cache
    //
    // query:
    // workspaceId
    // drawCode
    // fileId
    // holderType   เช่น S / M / R
    // holderCode   เช่น S01 / M01 / R01
    // =========================================================
    if (req.method === 'GET') {

      const workspaceId =
        clean(req.query?.workspaceId);

      const drawCode =
        upper(req.query?.drawCode);

      const fileId =
        upper(req.query?.fileId);

      const holderType =
        upper(req.query?.holderType);

      const holderCode =
        upper(req.query?.holderCode);


      if (!workspaceId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Workspace'
        });
      }

      if (!drawCode) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบงวด'
        });
      }

      if (!fileId) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ File ID'
        });
      }

      if (!holderType) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Holder Type'
        });
      }


      // =======================================================
      // ตรวจทะเบียนรูปต้นฉบับ
      // =======================================================
      const assetRows = await sql`
        select
          id,
          workspace_id,
          draw_code,
          file_id,
          source_filename,
          origin_role,
          origin_location,
          mime_type,
          file_size_bytes,
          checksum_sha256,
          status,
          created_at,
          updated_at
        from file_assets
        where workspace_id = ${workspaceId}
          and upper(draw_code) = ${drawCode}
          and upper(file_id) = ${fileId}
        limit 1
      `;


      if (!assetRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบทะเบียนรูปนี้'
        });
      }


      const asset =
        assetRows[0];


      if (asset.status !== 'AVAILABLE') {
        return res.status(409).json({
          ok: false,
          message: 'รูปต้นฉบับยังไม่พร้อมใช้งาน',
          assetStatus: asset.status
        });
      }


      // =======================================================
      // เช็ก cache ของผู้ถือ/เครื่องนี้
      // =======================================================
      const cacheRows = await sql`
        select
          id,
          workspace_id,
          draw_code,
          file_id,
          holder_type,
          holder_code,
          cache_location,
          cache_status,
          cached_at,
          last_verified_at,
          updated_at
        from file_cache_registry
        where workspace_id = ${workspaceId}
          and upper(draw_code) = ${drawCode}
          and upper(file_id) = ${fileId}
          and upper(holder_type) = ${holderType}
          and upper(
            coalesce(
              holder_code,
              ''
            )
          ) = ${holderCode}
        limit 1
      `;


      if (cacheRows.length) {

        const cache =
          cacheRows[0];

        if (
          cache.cache_status === 'CACHED' ||
          cache.cache_status === 'READY'
        ) {

          return res.status(200).json({
            ok: true,
            cacheState: 'CACHE_HIT',
            message: 'พบ cache แล้ว',

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
                asset.origin_location || '',

              mimeType:
                asset.mime_type || '',

              fileSizeBytes:
                asset.file_size_bytes === null
                  ? null
                  : Number(asset.file_size_bytes),

              checksumSha256:
                asset.checksum_sha256 || '',

              status:
                asset.status
            },

            cache: {
              holderType:
                cache.holder_type,

              holderCode:
                cache.holder_code || '',

              cacheLocation:
                cache.cache_location || '',

              cacheStatus:
                cache.cache_status,

              cachedAt:
                cache.cached_at,

              lastVerifiedAt:
                cache.last_verified_at
            }
          });
        }
      }


      return res.status(200).json({
        ok: true,
        cacheState: 'NEED_FETCH',
        message: 'ยังไม่มี cache ต้องขอรูปจาก R/Bridge',

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
            asset.origin_location || '',

          mimeType:
            asset.mime_type || '',

          fileSizeBytes:
            asset.file_size_bytes === null
              ? null
              : Number(asset.file_size_bytes),

          checksumSha256:
            asset.checksum_sha256 || '',

          status:
            asset.status
        }
      });
    }


    // =========================================================
    // POST
    //
    // REGISTER_CACHE
    // = Bridge/Runtime แจ้งว่ารูปถูกเก็บใน Flash/cache แล้ว
    //
    // INVALIDATE_CACHE
    // = cache ใช้ไม่ได้ / หาไฟล์ไม่เจอ / checksum ไม่ตรง
    // =========================================================
    if (req.method === 'POST') {

      const {
        action,
        workspaceId,
        drawCode,
        fileId,
        holderType,
        holderCode,
        cacheLocation
      } = req.body || {};


      const command =
        upper(action);

      const workspace =
        clean(workspaceId);

      const draw =
        upper(drawCode);

      const file =
        upper(fileId);

      const type =
        upper(holderType);

      const code =
        upper(holderCode);

      const location =
        clean(cacheLocation);


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

      if (!type) {
        return res.status(400).json({
          ok: false,
          message: 'ไม่พบ Holder Type'
        });
      }


      // =======================================================
      // ตรวจ asset ก่อนทุกครั้ง
      // =======================================================
      const assetRows = await sql`
        select
          id,
          file_id,
          status
        from file_assets
        where workspace_id = ${workspace}
          and upper(draw_code) = ${draw}
          and upper(file_id) = ${file}
        limit 1
      `;


      if (!assetRows.length) {
        return res.status(404).json({
          ok: false,
          message: 'ไม่พบทะเบียนรูปนี้'
        });
      }


      if (command === 'REGISTER_CACHE') {

        if (!location) {
          return res.status(400).json({
            ok: false,
            message: 'ไม่พบตำแหน่ง cache'
          });
        }


        const rows = await sql`
          insert into file_cache_registry (
            workspace_id,
            draw_code,
            file_id,
            holder_type,
            holder_code,
            cache_location,
            cache_status,
            cached_at,
            last_verified_at,
            updated_at
          )

          values (
            ${workspace},
            ${draw},
            ${file},
            ${type},
            ${code || null},
            ${location},
            'CACHED',
            now(),
            now(),
            now()
          )

          on conflict (
            workspace_id,
            draw_code,
            file_id,
            holder_type,
            holder_code
          )

          do update set
            cache_location =
              excluded.cache_location,

            cache_status =
              'CACHED',

            last_verified_at =
              now(),

            updated_at =
              now()

          returning
            id,
            workspace_id,
            draw_code,
            file_id,
            holder_type,
            holder_code,
            cache_location,
            cache_status,
            cached_at,
            last_verified_at,
            updated_at
        `;


        const row =
          rows[0];


        return res.status(200).json({
          ok: true,
          message: 'ลงทะเบียน cache สำเร็จ',

          cache: {
            workspaceId:
              row.workspace_id,

            drawCode:
              row.draw_code,

            fileId:
              row.file_id,

            holderType:
              row.holder_type,

            holderCode:
              row.holder_code || '',

            cacheLocation:
              row.cache_location || '',

            cacheStatus:
              row.cache_status,

            cachedAt:
              row.cached_at,

            lastVerifiedAt:
              row.last_verified_at
          }
        });
      }


      if (command === 'INVALIDATE_CACHE') {

        const rows = await sql`
          update file_cache_registry

          set
            cache_status = 'INVALID',
            last_verified_at = now(),
            updated_at = now()

          where workspace_id = ${workspace}
            and upper(draw_code) = ${draw}
            and upper(file_id) = ${file}
            and upper(holder_type) = ${type}
            and upper(
              coalesce(
                holder_code,
                ''
              )
            ) = ${code}

          returning
            id,
            file_id,
            cache_status
        `;


        if (!rows.length) {
          return res.status(404).json({
            ok: false,
            message: 'ไม่พบ cache ที่ต้องการยกเลิก'
          });
        }


        return res.status(200).json({
          ok: true,
          message: 'ยกเลิก cache แล้ว',
          fileId:
            rows[0].file_id,
          cacheStatus:
            rows[0].cache_status
        });
      }


      return res.status(400).json({
        ok: false,
        message: 'Action ไม่ถูกต้อง'
      });
    }


    return res.status(405).json({
      ok: false,
      message: 'Method not allowed'
    });

  } catch (error) {

    console.error(
      'file-cache api error:',
      error
    );


    return res.status(500).json({
      ok: false,
      message:
        'ระบบตรวจ cache เกิดข้อผิดพลาด'
    });
  }
}
