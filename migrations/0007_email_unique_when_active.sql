ALTER TABLE "core"."users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
DROP INDEX "core"."users_clerk_user_id_idx";--> statement-breakpoint
DROP INDEX "core"."users_email_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_active_idx" ON "core"."users" USING btree ("email") WHERE deleted_at is null;