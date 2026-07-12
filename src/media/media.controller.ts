import {
  BadRequestException, Controller, Delete, Get, Inject, Param, ParseUUIDPipe,
  Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CloudinaryService } from './cloudinary.service';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = /^image\/(jpe?g|png|webp|gif|avif)$|^video\/(mp4|webm)$/;

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Post('uploads')
  @Throttle({ default: { ttl: 3_600_000, limit: 50 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Query('folder') folder?: string,
  ) {
    if (!file) throw new BadRequestException('Attach a file under the "file" field');
    if (!ALLOWED_MIME.test(file.mimetype)) {
      throw new BadRequestException(`Unsupported type ${file.mimetype}`);
    }

    const isVideo = file.mimetype.startsWith('video/');
    const result = await this.cloudinary.upload(file.buffer, {
      folder: folder?.replace(/[^a-z0-9_-]/gi, ''),
      resourceType: isVideo ? 'video' : 'image',
    });

    const row = await this.pool.query(
      `INSERT INTO media_assets (uploader_id, kind, storage_key, cdn_url, mime_type,
                                 size_bytes, width, height, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, kind, cdn_url, width, height, created_at`,
      [
        req.user.sub,
        isVideo ? 'video' : 'image',
        result.public_id,
        result.secure_url,
        file.mimetype,
        file.size,
        result.width ?? null,
        result.height ?? null,
        (result as any).duration ?? null,
      ],
    );
    return row.rows[0];
  }

  @Get()
  async list(@Req() req: any, @Query('limit') limit = '50') {
    const res = await this.pool.query(
      `SELECT id, kind, cdn_url, mime_type, size_bytes, width, height, created_at
       FROM media_assets WHERE uploader_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.user.sub, Math.min(Number(limit) || 50, 200)],
    );
    return res.rows;
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const res = await this.pool.query(
      `DELETE FROM media_assets WHERE id = $1 AND uploader_id = $2 RETURNING storage_key`,
      [id, req.user.sub],
    );
    if (res.rowCount === 0) throw new BadRequestException('Asset not found or not yours');
    await this.cloudinary.destroy(res.rows[0].storage_key);
    return { deleted: true };
  }
}
