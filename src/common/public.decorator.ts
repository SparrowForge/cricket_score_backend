import { SetMetadata } from '@nestjs/common';

/** Marks an endpoint as public (no JWT). Documentation marker — guards are opt-in per controller/route. */
export const Public = () => SetMetadata('isPublic', true);
