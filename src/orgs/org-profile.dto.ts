import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsNumber,
  IsObject, IsOptional, IsString, IsUrl, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export const ORG_TYPES = ['club', 'academy', 'association', 'corporate', 'school', 'other'] as const;
export const ORG_STATUSES = ['active', 'inactive', 'suspended'] as const;
export const ORG_VISIBILITIES = ['public', 'private'] as const;

/** Optional free-text field. Empty string is normalised to null by the service. */
const Text = (max: number) => (target: object, key: string) => {
  IsOptional()(target, key);
  IsString()(target, key);
  MaxLength(max)(target, key);
};

/** Optional list of short strings — titles, awards, jersey colours, gallery urls. */
const StringList = (maxItems: number, maxLen = 200) => (target: object, key: string) => {
  IsOptional()(target, key);
  IsArray()(target, key);
  ArrayMaxSize(maxItems)(target, key);
  IsString({ each: true })(target, key);
  MaxLength(maxLen, { each: true })(target, key);
};

/* ---------------- jsonb groups ----------------
 * Each group is stored as one jsonb column and PATCHed as a whole: sending
 * `facilities` replaces the entire facilities object rather than merging into
 * it, so a form section that owns the group can clear a field by omitting it.
 * Omit the group itself to leave it untouched. */

export class RegistrationDto {
  @Text(80)  number?: string;
  @Text(160) authority?: string;
  @IsOptional() @IsISO8601() date?: string;
  @Text(80)  tax_id?: string;
  @IsOptional() @IsString() @MaxLength(500) certificate_url?: string;
}

export class CricketDetailsDto {
  @IsOptional() @IsIn(['senior', 'junior', 'women', 'corporate', 'mixed'])
  team_category?: string;

  /** Format slugs from /formats — free-form so a custom format still fits. */
  @StringList(20, 40) formats?: string[];

  @IsOptional() @IsIn(['amateur', 'semi_pro', 'professional'])
  skill_level?: string;

  @IsOptional() @IsInt() @Min(2) @Max(30)
  default_squad_size?: number;

  @StringList(6, 40) jersey_colors?: string[];
  @Text(500) kit_details?: string;
}

export class FacilitiesDto {
  @IsOptional() @IsIn(['own', 'rented', 'shared'])
  ground_ownership?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(3)
  @IsIn(['nets', 'indoor', 'bowling_machine'], { each: true })
  practice?: string[];

  @IsOptional() @IsBoolean() dressing_room?: boolean;
  @IsOptional() @IsBoolean() flood_lights?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(200_000) seating_capacity?: number;
}

export class AchievementsDto {
  @StringList(50) titles?: string[];
  @StringList(50) recent_results?: string[];
  @StringList(50) notable_players?: string[];
  @StringList(50) awards?: string[];
}

export class SocialDto {
  @IsOptional() @IsUrl() @MaxLength(300) facebook?: string;
  @IsOptional() @IsUrl() @MaxLength(300) youtube?: string;
  @IsOptional() @IsUrl() @MaxLength(300) instagram?: string;
  @IsOptional() @IsUrl() @MaxLength(300) twitter?: string;
  @StringList(60, 500) gallery?: string[];
  @StringList(30, 500) videos?: string[];
}

/**
 * Every profile field. Used by PATCH /orgs/:orgId — see UpdateOrgDto.
 *
 * `undefined` leaves a field alone; an explicit `null` (or `''` for text)
 * clears it. That distinction is why the service builds its SET list from the
 * keys actually sent rather than `coalesce($n, col)`.
 */
export class OrgProfileDto {
  /* Basic information */
  @Text(40)  short_name?: string;
  @IsOptional() @IsIn(ORG_TYPES as unknown as string[]) org_type?: string;
  @IsOptional() @IsString() @MaxLength(500) banner_url?: string;
  @IsOptional() @IsInt() @Min(1700) @Max(2100) established_year?: number | null;
  @Text(4000) description?: string;

  /* Address & location */
  @Text(80)  country?: string;
  @Text(80)  division?: string;
  @Text(80)  city?: string;
  @Text(300) address_line?: string;
  @Text(20)  postal_code?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number | null;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number | null;
  @Text(160) home_ground?: string;

  /* Contact */
  @Text(120) contact_name?: string;
  @Text(80)  contact_designation?: string;
  @Text(40)  contact_phone?: string;
  @Text(40)  contact_phone_alt?: string;
  @IsOptional() @IsEmail() @MaxLength(160) contact_email?: string | null;
  @IsOptional() @IsString() @MaxLength(300) website_url?: string;

  /* System / app */
  @IsOptional() @IsIn(ORG_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsIn(ORG_VISIBILITIES as unknown as string[]) visibility?: string;

  /* jsonb groups */
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RegistrationDto)
  registration?: RegistrationDto;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => CricketDetailsDto)
  cricket_details?: CricketDetailsDto;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => FacilitiesDto)
  facilities?: FacilitiesDto;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => AchievementsDto)
  achievements?: AchievementsDto;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => SocialDto)
  social?: SocialDto;
}

/** Columns PATCH may write, and how each value is prepared for pg. */
export const ORG_TEXT_COLUMNS = [
  'short_name', 'banner_url', 'description', 'country', 'division', 'city',
  'address_line', 'postal_code', 'home_ground', 'contact_name',
  'contact_designation', 'contact_phone', 'contact_phone_alt', 'contact_email',
  'website_url',
] as const;

export const ORG_NUMBER_COLUMNS = ['established_year', 'latitude', 'longitude'] as const;

/** Postgres needs the enum cast spelled out; see CLAUDE.md. */
export const ORG_ENUM_COLUMNS: Record<string, string> = {
  org_type: 'org_type',
  status: 'org_status',
  visibility: 'org_visibility',
};

export const ORG_JSON_COLUMNS = [
  'registration', 'cricket_details', 'facilities', 'achievements', 'social',
] as const;
