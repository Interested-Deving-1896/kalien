import { useEffect } from "react";

const BASE_TITLE = "Kalien";
const DEFAULT_DESCRIPTION =
  "Play deterministic Asteroids, prove your runs, and climb a verifiable on-chain leaderboard with Kalien.";
const DEFAULT_IMAGE = "https://kalien.xyz/kalien-meta-2.jpg";
const DEFAULT_TYPE = "website";
const FALLBACK_SITE_URL = "https://kalien.xyz";

interface DocumentMetaOptions {
  description?: string;
  image?: string;
  noIndex?: boolean;
  path?: string;
  type?: string;
}

function upsertMetaTag(selector: string, attributes: Record<string, string>) {
  let meta = document.head.querySelector<HTMLMetaElement>(selector);
  if (!meta) {
    meta = document.createElement("meta");
    document.head.appendChild(meta);
  }
  Object.entries(attributes).forEach(([key, value]) => {
    meta.setAttribute(key, value);
  });
}

function upsertCanonicalLink(href: string) {
  let link = document.head.querySelector<HTMLLinkElement>("link[rel='canonical']");
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", href);
}

function normalizePath(path: string): string {
  if (!path.trim()) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function toAbsoluteUrl(path: string): string {
  const base = window.location.origin || FALLBACK_SITE_URL;
  return new URL(normalizePath(path), base).toString();
}

export function useDocumentTitle(subtitle?: string, options?: DocumentMetaOptions) {
  const description = options?.description;
  const image = options?.image;
  const noIndex = options?.noIndex;
  const path = options?.path;
  const type = options?.type;

  useEffect(() => {
    const pageTitle = subtitle ? `${subtitle} | ${BASE_TITLE}` : BASE_TITLE;
    const pageDescription = description?.trim() || DEFAULT_DESCRIPTION;
    const pageImage = image?.trim() || DEFAULT_IMAGE;
    const pageType = type?.trim() || DEFAULT_TYPE;
    const canonicalPath = path ?? window.location.pathname;
    const canonicalUrl = toAbsoluteUrl(canonicalPath);
    const robots = noIndex ? "noindex,nofollow" : "index,follow";

    document.title = pageTitle;

    upsertCanonicalLink(canonicalUrl);
    upsertMetaTag("meta[name='description']", {
      name: "description",
      content: pageDescription,
    });
    upsertMetaTag("meta[name='robots']", { name: "robots", content: robots });

    upsertMetaTag("meta[property='og:type']", {
      property: "og:type",
      content: pageType,
    });
    upsertMetaTag("meta[property='og:site_name']", {
      property: "og:site_name",
      content: BASE_TITLE,
    });
    upsertMetaTag("meta[property='og:title']", {
      property: "og:title",
      content: pageTitle,
    });
    upsertMetaTag("meta[property='og:description']", {
      property: "og:description",
      content: pageDescription,
    });
    upsertMetaTag("meta[property='og:url']", {
      property: "og:url",
      content: canonicalUrl,
    });
    upsertMetaTag("meta[property='og:image']", {
      property: "og:image",
      content: pageImage,
    });

    upsertMetaTag("meta[name='twitter:card']", {
      name: "twitter:card",
      content: "summary_large_image",
    });
    upsertMetaTag("meta[name='twitter:title']", {
      name: "twitter:title",
      content: pageTitle,
    });
    upsertMetaTag("meta[name='twitter:description']", {
      name: "twitter:description",
      content: pageDescription,
    });
    upsertMetaTag("meta[name='twitter:image']", {
      name: "twitter:image",
      content: pageImage,
    });
  }, [subtitle, description, image, noIndex, path, type]);
}
