CREATE TABLE "CommunitySongLike" (
	"songId" integer NOT NULL,
	"userId" integer NOT NULL,
	"syncedToVote" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "CommunitySongLike_songId_userId_pk" PRIMARY KEY("songId","userId")
);
--> statement-breakpoint
ALTER TABLE "CommunitySongLike" ADD CONSTRAINT "CommunitySongLike_songId_Song_id_fk" FOREIGN KEY ("songId") REFERENCES "public"."Song"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CommunitySongLike" ADD CONSTRAINT "CommunitySongLike_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "CommunitySongLike_user_idx" ON "CommunitySongLike" USING btree ("userId","createdAt");
--> statement-breakpoint
CREATE INDEX "CommunitySongLike_sync_idx" ON "CommunitySongLike" USING btree ("syncedToVote","songId");
--> statement-breakpoint
ALTER TABLE "CommunityPostLike" ADD COLUMN "revealToAuthor" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "CommunityComment_parent_idx" ON "CommunityComment" USING btree ("parentId","createdAt");
--> statement-breakpoint
ALTER TABLE "CommunityComment" ADD COLUMN "likeCount" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "CommunityCommentLike" (
	"commentId" integer NOT NULL,
	"userId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "CommunityCommentLike_commentId_userId_pk" PRIMARY KEY("commentId","userId")
);
--> statement-breakpoint
ALTER TABLE "CommunityCommentLike" ADD CONSTRAINT "CommunityCommentLike_commentId_CommunityComment_id_fk" FOREIGN KEY ("commentId") REFERENCES "public"."CommunityComment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CommunityCommentLike" ADD CONSTRAINT "CommunityCommentLike_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "CommunityCommentLike_user_idx" ON "CommunityCommentLike" USING btree ("userId","createdAt");
