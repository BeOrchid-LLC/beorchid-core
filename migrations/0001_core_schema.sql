CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TABLE "core"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text,
	"billing_customer_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_billing_customer_id_unique" UNIQUE("billing_customer_id")
);
--> statement-breakpoint
CREATE TABLE "core"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text,
	"name" text NOT NULL,
	"slug" "citext" NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "core"."apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "citext" NOT NULL,
	"name" text NOT NULL,
	"schema_name" text NOT NULL,
	"db_role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_key_unique" UNIQUE("key"),
	CONSTRAINT "apps_schema_name_unique" UNIQUE("schema_name"),
	CONSTRAINT "apps_db_role_unique" UNIQUE("db_role")
);
--> statement-breakpoint
CREATE TABLE "core"."permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"app_id" uuid,
	"description" text,
	CONSTRAINT "permissions_app_id_key_uniq" UNIQUE NULLS NOT DISTINCT("app_id","key")
);
--> statement-breakpoint
CREATE TABLE "core"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "core"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "core"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_org_uniq" UNIQUE("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "core"."app_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_role_assignments_membership_app_uniq" UNIQUE("membership_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "core"."webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"app_id" uuid,
	"actor_user_id" uuid,
	"org_id" uuid,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" uuid,
	"result" text NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "core"."permissions" ADD CONSTRAINT "permissions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "core"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "core"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "core"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."app_role_assignments" ADD CONSTRAINT "app_role_assignments_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "core"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."app_role_assignments" ADD CONSTRAINT "app_role_assignments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "core"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."app_role_assignments" ADD CONSTRAINT "app_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "core"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."access_log" ADD CONSTRAINT "access_log_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "core"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."access_log" ADD CONSTRAINT "access_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "core"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."access_log" ADD CONSTRAINT "access_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "core"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_clerk_user_id_idx" ON "core"."users" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "users_email_active_idx" ON "core"."users" USING btree ("email") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "core"."memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_org_id_idx" ON "core"."memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "app_role_assignments_app_id_idx" ON "core"."app_role_assignments" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "access_log_app_occurred_idx" ON "core"."access_log" USING btree ("app_id","occurred_at");--> statement-breakpoint
CREATE INDEX "access_log_actor_occurred_idx" ON "core"."access_log" USING btree ("actor_user_id","occurred_at");