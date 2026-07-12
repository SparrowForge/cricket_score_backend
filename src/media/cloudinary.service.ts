import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

@Injectable()
export class CloudinaryService implements OnModuleInit {
  onModuleInit() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  /** Credentials check used by the smoke test. */
  ping(): Promise<{ status: string }> {
    return cloudinary.api.ping();
  }

  upload(buffer: Buffer, options: { folder?: string; resourceType?: 'image' | 'video' | 'raw' } = {}) {
    const folder = [process.env.CLOUDINARY_FOLDER ?? process.env.CLOUDINARY_FOLDER, options.folder]
      .filter(Boolean)
      .join('/');

    return new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: options.resourceType ?? 'image',
          unique_filename: true,
          overwrite: false,
        },
        (err, result) => {
          if (err || !result) return reject(new BadRequestException(err?.message ?? 'Upload failed'));
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  destroy(publicId: string) {
    return cloudinary.uploader.destroy(publicId);
  }
}
