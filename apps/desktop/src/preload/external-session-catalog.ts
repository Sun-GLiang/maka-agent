import type { ExternalSessionCatalogItem } from '@maka/runtime-host/protocol';

/** Renderer projection of a Host external Session catalog item. */
export type DesktopExternalSessionCatalogItem = Omit<ExternalSessionCatalogItem, 'hostCwd'> & {
  /** Main maps the Host-only path name onto Desktop's existing cwd vocabulary. */
  readonly cwd: string;
};
