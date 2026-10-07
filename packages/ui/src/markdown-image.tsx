/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Spinner, Tooltip, useLightbox } from '@astryxdesign/core';
import { createMarkdownPlugin, type MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import type { MarkdownAstNode, MarkdownAstRoot } from '@astryxdesign/core/Markdown';
import { Maximize2, RotateCw, AlertTriangle } from './icons.js';
import { Link } from '@astryxdesign/core/Link';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { useAttachmentImage } from './attachment-image.js';
import { useImageDelivery } from './image-delivery.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';

const ImageSourceContext = createContext<(source: string) => string>((source) => source);

type PlacedImage = MarkdownExtensionNode<'maka-images', 'image', { src: string; alt: string; inline: boolean }>;
// Placement comes from Markdown structure before bytes arrive. Never change a
// message's geometry in response to network/decode timing or archive resolution.
export const MARKDOWN_IMAGE_PLUGINS = [createMarkdownPlugin<'maka-images', PlacedImage>({
  name: 'maka-images', apiVersion: 1,
  transform(document, context) {
    if (!context.source.includes('![')) return document;
    const rewrite = (node: MarkdownAstNode, inline = false, phrasing = false): MarkdownAstNode => {
      if (node.type === 'image') return {
        type: 'extension', plugin: 'maka-images', name: 'image',
        display: phrasing ? 'inline' : 'block',
        data: { src: node.url, alt: node.alt, inline },
      } satisfies PlacedImage;
      if (!('children' in node)) return node;
      const childInline = node.type === 'paragraph' ? !isSingleImage(node.children)
        : node.type === 'heading' || node.type === 'tableCell' ? true : inline;
      const childPhrasing = ['paragraph', 'heading', 'tableCell', 'link', 'strong', 'emphasis', 'delete'].includes(node.type);
      return { ...node, children: node.children.map(child => rewrite(child, childInline, childPhrasing)) } as MarkdownAstNode;
    };
    return rewrite(document) as MarkdownAstRoot<MarkdownExtensionNode>;
  },
  renderers: { image: {
    render: ({ node }) => <MarkdownImage {...node.data} />,
    toText: node => node.data.alt,
  } },
})];

function isSingleImage(nodes: readonly MarkdownAstNode[]): boolean {
  const meaningful = nodes.filter(node => node.type !== 'text' || node.value.trim());
  if (meaningful.length !== 1) return false;
  const node = meaningful[0]!;
  return node.type === 'image' || (['link', 'strong', 'emphasis', 'delete'].includes(node.type)
    && 'children' in node && isSingleImage(node.children));
}
export function MarkdownImageSourceProvider(props: { text: string; sources?: ReadonlyMap<string, string>; children: ReactNode }) {
  const resolve = useMemo(() => {
    const canonical = createMarkdownImageSourceResolver(props.text);
    return (source: string) => {
      const resolved = canonical(source);
      return props.sources?.get(resolved) ?? resolved;
    };
  }, [props.text, props.sources]);
  return <ImageSourceContext.Provider value={resolve}>{props.children}</ImageSourceContext.Provider>;
}

/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function MarkdownImage(props: { src: string; alt: string; inline?: boolean }) {
  const source = useContext(ImageSourceContext)(props.src);
  return <ImageResource key={source} src={source} alt={props.alt} inline={props.inline} />;
}
function ImageResource(props: { src: string; alt: string; inline?: boolean }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || !anchor.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(anchor.current); return () => observer.disconnect();
  }, [visible]);
  const explicit = parseAttachmentResourceRef(props.src);
  const delivery = useImageDelivery(props.src, visible && !explicit);
  const artifactId = explicit?.artifactId ?? (delivery.status === 'ready' ? delivery.artifactId : undefined);
  const image = useAttachmentImage(visible && artifactId ? { artifactId } : undefined);
  const [failedSource, setFailedSource] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const remote = isWebImage(props.src);
  const source = artifactId ? image.src : visible && remote && (!delivery.available || delivery.checked) ? props.src : undefined;
  const failed = !!source && failedSource === source || !!artifactId && image.status === 'failed';
  const retry = () => {
    setFailedSource(undefined); setAttempt(a => a + 1);
    if (artifactId) image.retry();
    // A transient byte-read failure retries the saved attachment. Only a
    // browser decode failure invalidates automatic capture and rereads origin.
    if (!artifactId || (!explicit && source && failedSource === source)) delivery.retry();
  };
  const sourceActions = <span className="maka-markdown-image-actions">
    <Button variant="ghost" size="sm" label={copy.imageRetry} onClick={retry} />
    {remote && <Link href={props.src} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>}
  </span>;
  let message: string | undefined;
  if (failed) message = copy.imageLoadFailed;
  else if (!source) message = !visible ? copy.imageLoading
    : explicit && image.status === 'unavailable' ? copy.imageUnavailable
    : delivery.status === 'failed' ? copy.imageArchiveFailure(delivery.reason)
    : delivery.status === 'pending' || artifactId ? copy.imageLoading : copy.imageUnsupported;
  const hasFrame = props.inline || !visible || !!source || !!artifactId || delivery.status === 'pending';
  return <span ref={anchor} className={`maka-markdown-image-resource${hasFrame ? props.inline ? ' maka-markdown-image-inline' : ' maka-markdown-image-frame' : ''}`}
    data-maka-image-state={message ? failed ? 'failed' : 'loading' : 'ready'}>
    {message && props.inline ? <Tooltip content={message}>
      <span className="maka-markdown-image-placeholder" role="status" aria-label={message}>
        {failed || delivery.status === 'failed'
          ? <IconButton icon={<RotateCw size={14} />} size="sm" label={copy.imageRetry} onClick={retry} />
          : delivery.status === 'unavailable' && visible
            ? <AlertTriangle size={14} aria-hidden="true" /> : <Spinner size="sm" shade="subtle" aria-hidden="true" />}
      </span>
    </Tooltip> : message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{hasFrame && !failed && delivery.status !== 'failed' && <Spinner size="sm" shade="subtle" aria-hidden="true" />} {message}</span>
      {(failed || delivery.status === 'failed') && sourceActions}
    </span> : source && <DisplayImage key={`${source}\0${attempt}`} src={source} alt={props.alt} onError={() => setFailedSource(source)} />}
    {!explicit && delivery.status === 'pending' && remote && source && (props.inline ? <Tooltip content={copy.imageSaving}>
      <span className="maka-markdown-image-saving" role="status" aria-label={copy.imageSaving}><Spinner size="sm" aria-hidden="true" /></span>
    </Tooltip> : <span className="maka-markdown-image-saving" role="status">{copy.imageSaving}</span>)}
    {!explicit && delivery.status === 'failed' && remote && source && !failed && (props.inline ? <Tooltip content={copy.imageArchiveFailure(delivery.reason)}>
      <span className="maka-markdown-image-saving" role="status" aria-label={copy.imageArchiveFailure(delivery.reason)}>
        <IconButton icon={<AlertTriangle size={14} />} size="sm" label={copy.imageRetry} onClick={retry} />
      </span>
    </Tooltip> : <span className="maka-markdown-image-saving" role="status">
      {copy.imageArchiveFailure(delivery.reason)} {sourceActions}
    </span>)}
  </span>;
}
function DisplayImage(props: { src: string; alt: string; onError(): void }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const [loaded, setLoaded] = useState(false);
  const lightbox = useLightbox({ media: { src: props.src, alt: props.alt }, hasZoom: true });
  return <>
    <span className="maka-markdown-image-preview">
      {!loaded && <span className="maka-markdown-image-loading" role="status" aria-label={copy.imageLoading}><Spinner size="sm" shade="subtle" aria-hidden="true" /> <span className="maka-markdown-image-loading-label">{copy.imageLoading}</span></span>}
      <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
          className="maka-markdown-attachment-image" onLoad={() => setLoaded(true)} onError={props.onError} />
      {loaded && <span className="maka-markdown-image-expand">
        <IconButton icon={<Maximize2 size={16} />} size="sm" label={copy.imageExpand(props.alt)} onClick={event => { event.preventDefault(); event.stopPropagation(); lightbox.open(); }} />
      </span>}
    </span>
    {lightbox.isOpen && lightbox.element}
  </>;
}
function isWebImage(source: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(source).protocol); } catch { return false; }
}
