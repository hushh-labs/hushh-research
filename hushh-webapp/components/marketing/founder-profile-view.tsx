import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink, GraduationCap, Linkedin, User } from "lucide-react";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { Card, CardGrid } from "@/components/app-ui/sections";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ROUTES } from "@/lib/navigation/routes";
import { BLOG_POSTS } from "@/lib/research/blog";
import { formatBlogDate } from "@/lib/research/format-blog-date";

const AVATAR_SRC = "/manish-sainani.png";

const FOUNDER_LINKS = [
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/manishsainani",
    icon: Linkedin,
  },
  {
    label: "@manish_sainani on X",
    href: "https://x.com/manish_sainani",
    icon: ExternalLink,
  },
];

export function FounderProfileView() {
  return (
    <AppPageShell width="reading" className="pb-8 pt-0 sm:pb-10">
      <AppPageHeaderRegion>
        <Link
          href={ROUTES.HOME}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-sky-700 dark:hover:text-sky-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Hussh
        </Link>

        <PageHeader
          eyebrow="Founder & CEO"
          title="Manish Sainani"
          description="Building personal agent infrastructure people own — Hussh One and the open consent protocol PCHP."
          descriptionFullWidth
          accent="default"
          leading={
            <Image
              src={AVATAR_SRC}
              alt="Manish Sainani"
              width={64}
              height={64}
              className="h-16 w-16 rounded-full object-cover"
              priority
            />
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-6">
        <CardGrid cols={2}>
          <Card
            icon={<User className="h-5 w-5" />}
            eyebrow="Role"
            title="Founder & CEO"
            body="Hussh"
          />
          <Card
            icon={<GraduationCap className="h-5 w-5" />}
            eyebrow="Education"
            title="Purdue University"
            body="B.S. Computer Science, minor in Mathematics, Management & Finance."
          />
        </CardGrid>

        <div className="mt-8 border-t border-border/60 pt-6">
          <h2 className="text-lg font-semibold text-foreground">Overview</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Manish Sainani is the Founder & CEO of Hussh, building personal
            agent infrastructure people own: Hussh One, and the open consent
            protocol PCHP — a public standard for scoped, auditable consent
            between people and agents.
          </p>
        </div>

        <div className="mt-8 border-t border-border/60 pt-6">
          <h2 className="text-lg font-semibold text-foreground">Writing</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {BLOG_POSTS.map((post) => (
              <li key={post.slug}>
                <Link
                  href={`/blog/${post.slug}`}
                  className="text-sm font-medium text-[color:var(--app-accent-deep)] hover:underline"
                >
                  {post.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatBlogDate(post.date)}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-8 border-t border-border/60 pt-6">
          <h2 className="text-lg font-semibold text-foreground">Elsewhere</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {FOUNDER_LINKS.map(({ label, href, icon: Icon }) => (
              <li key={href}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-[color:var(--app-accent-deep)] hover:underline"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
