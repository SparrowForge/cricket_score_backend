import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { ORG_TYPES } from './org-profile.dto';
import { OrgsService } from './orgs.service';

/**
 * The public face of an organization: the /clubs directory and each club's
 * profile page. No auth — note there is deliberately no class-level
 * JwtAuthGuard here, the same way player profiles are open.
 *
 * Separate from OrgsController because that one is entirely owner/member
 * gated and keys off a uuid `:orgId`; a public URL wants the slug.
 */
@ApiTags('Clubs')
@Controller('clubs')
export class PublicClubsController {
  constructor(private readonly orgs: OrgsService) {}

  /** Directory of listed clubs. Filters: q, city, country, type. */
  @Public()
  @Get()
  list(
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('country') country?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orgs.publicList({
      q,
      city,
      country,
      // Silently drop an unknown type rather than 400 — this is a URL a user
      // can hand-edit, and an empty filter is a friendlier answer than an error.
      type: ORG_TYPES.includes(type as (typeof ORG_TYPES)[number]) ? type : undefined,
      limit: Math.min(Math.max(Number(limit) || 24, 1), 100),
      offset: Math.max(Number(offset) || 0, 0),
    });
  }

  /** Cities with at least one listed club, for the directory's city filter. */
  @Public()
  @Get('cities')
  cities() {
    return this.orgs.publicCities();
  }

  /** One club's public profile. 404s for private, inactive or deleted clubs. */
  @Public()
  @Get(':slug')
  profile(@Param('slug') slug: string) {
    return this.orgs.publicProfile(slug);
  }
}
