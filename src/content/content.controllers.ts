import {
  Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsArray, IsEmail, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength,
} from 'class-validator';
import { JwtAuthGuard, JwtPayload } from '../auth/jwt-auth.guard';
import { AccessService, CurrentUser, Roles, RolesGuard } from '../common/auth';
import { Public } from '../common/public.decorator';
import { ContentService } from './content.service';

// ---------------- DTOs ----------------
class CreateNewsDto {
  @IsString() @IsNotEmpty() @MaxLength(200) title!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,120}$/) slug!: string;
  @IsOptional() @IsString() @MaxLength(500) excerpt?: string;
  /** Rich-text block document */
  @IsOptional() @IsObject() body?: object;
  @IsOptional() @IsUUID() cover_asset_id?: string;
  @IsOptional() @IsArray() tags?: string[];
  @IsOptional() @IsUUID() tournament_id?: string;
  @IsOptional() @IsUUID() match_id?: string;
}

class UpdateNewsDto extends CreateNewsDto {
  @IsOptional() @IsString() declare title: string;
  @IsOptional() declare slug: string;
}

class CreatePageDto {
  @Matches(/^[a-z0-9][a-z0-9/-]{0,120}$/) slug!: string;
  @IsString() @IsNotEmpty() title!: string;
  /** Ordered block array: [{"id":"hero","type":"hero","props":{…}}] */
  @IsOptional() @IsArray() blocks?: object[];
  @IsOptional() @IsObject() seo?: object;
}

class UpdatePageDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsArray() blocks?: object[];
  @IsOptional() @IsObject() seo?: object;
}

class SettingDto {
  /** Any JSON value */
  value!: any;
}

class ContactDto {
  @IsOptional() @IsIn(['contact', 'demo_request', 'schedule_request', 'pricing', 'support']) kind?: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) organization?: string;
  /** Free text on purpose: "first weekend of March" is a useful answer too. */
  @IsOptional() @IsString() @MaxLength(120) preferred_date?: string;
  @IsOptional() @IsString() @MaxLength(4000) message?: string;
  /** Honeypot — hidden in the form, so anything here came from a bot. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

// ---------------- News ----------------
@ApiTags('News')
@Controller()
export class NewsController {
  constructor(private readonly content: ContentService, private readonly access: AccessService) {}

  /** Published news feed. */
  @Public() @Get('news')
  list(@Query('tournament') tournament?: string, @Query('tag') tag?: string, @Query('limit') limit?: number) {
    return this.content.publicNews({ tournament, tag, limit: limit ? Number(limit) : undefined });
  }

  @Public() @Get('news/:slug')
  article(@Param('slug') slug: string) {
    return this.content.newsArticle(slug);
  }

  /** Org news manager list — includes drafts/unpublished. */
  @Get('orgs/:orgId/news')
  @UseGuards(JwtAuthGuard)
  async orgList(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: JwtPayload) {
    await this.access.assertOrgMember(orgId, user);
    return this.content.orgNews(orgId);
  }

  @Post('orgs/:orgId/news')
  @UseGuards(JwtAuthGuard)
  async create(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateNewsDto,
  ) {
    await this.access.assertOrgMember(orgId, user);
    return this.content.createNews(orgId, user.sub, dto);
  }

  @Patch('news-admin/:id')
  @UseGuards(JwtAuthGuard)
  async update(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateNewsDto) {
    const orgId = await this.content.newsOrg(id);
    if (orgId) await this.access.assertOrgMember(orgId, user);
    return this.content.updateNews(id, dto);
  }

  @Post('news-admin/:id/publish')
  @UseGuards(JwtAuthGuard)
  async publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    const orgId = await this.content.newsOrg(id);
    if (orgId) await this.access.assertOrgMember(orgId, user);
    return this.content.publishNews(id, true);
  }

  @Post('news-admin/:id/unpublish')
  @UseGuards(JwtAuthGuard)
  async unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    const orgId = await this.content.newsOrg(id);
    if (orgId) await this.access.assertOrgMember(orgId, user);
    return this.content.publishNews(id, false);
  }
}

// ---------------- CMS (marketing site) ----------------
@ApiTags('CMS')
@Controller('cms')
export class CmsController {
  constructor(private readonly content: ContentService) {}

  /** Published page for the marketing site renderer. */
  @Public() @Get('pages/:slug')
  page(@Param('slug') slug: string) {
    return this.content.publishedPage(slug);
  }

  /** Public site settings (nav, feature toggles the frontend needs). */
  @Public() @Get('settings')
  settings() {
    return this.content.siteSettings();
  }

  // ---- admin (super admin only) ----
  @Get('admin/pages')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  pages() {
    return this.content.allPages();
  }

  @Get('admin/pages/:id')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  pageDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.content.pageDetail(id);
  }

  @Post('admin/pages')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  createPage(@Body() dto: CreatePageDto) {
    return this.content.createPage(dto);
  }

  @Patch('admin/pages/:id')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  updatePage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePageDto) {
    return this.content.updatePage(id, dto);
  }

  /** Publish (snapshots a revision) or unpublish. */
  @Post('admin/pages/:id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.content.publishPage(id, user.sub, true);
  }

  @Post('admin/pages/:id/unpublish')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.content.publishPage(id, user.sub, false);
  }

  @Get('admin/pages/:id/revisions')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  revisions(@Param('id', ParseUUIDPipe) id: string) {
    return this.content.pageRevisions(id);
  }

  @Post('admin/pages/:id/revisions/:n/restore')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  restore(@Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number) {
    return this.content.restoreRevision(id, n);
  }

  @Put('admin/settings/:key')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  setSetting(@Param('key') key: string, @CurrentUser() user: JwtPayload, @Body() dto: SettingDto) {
    return this.content.setSetting(key, dto.value, user.sub);
  }
}

// ---------------- Contact ----------------
@ApiTags('Contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly content: ContentService) {}

  /** Marketing-site contact / demo-request form. */
  @Public()
  @Post()
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  submit(@Body() dto: ContactDto) {
    return this.content.submitContact(dto);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles('super_admin')
  submissions() {
    return this.content.contactSubmissions();
  }
}
