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
import { RotateCw, AlertTriangle } from './icons.js';
import { Link } from '@astryxdesign/core/Link';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { isRemoteImageSource } from '@maka/core/image-delivery';
import { useAttachmentImage } from './attachment-image.js';
import { useImageDelivery } from './image-delivery.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';
import { redactSecrets } from './redact.js';

const ImageSourceContext = createContext<(source: string) => { source: string; redacted: boolean }>(
  (source) => ({ source, redacted: false }),
);

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
      const original = props.sources?.get(resolved) ?? resolved;
      return { source: original, redacted: props.sources?.has(resolved) === true && original !== redactSecrets(original) };
    };
  }, [props.text, props.sources]);
  return <ImageSourceContext.Provider value={resolve}>{props.children}</ImageSourceContext.Provider>;
}

/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function MarkdownImage(props: { src: string; alt: string; inline?: boolean }) {
  const { source, redacted } = useContext(ImageSourceContext)(props.src);
  return <ImageResource key={source} src={source} redacted={redacted} alt={props.alt} inline={props.inline} />;
}
function ImageResource(props: { src: string; redacted: boolean; alt: string; inline?: boolean }) {
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
  const remote = isRemoteImageSource(props.src);
  const source = artifactId ? image.src : undefined;
  const failed = !!source && failedSource === source || !!artifactId && image.status === 'failed';
  const retry = () => {
    setFailedSource(undefined); setAttempt(a => a + 1);
    if (artifactId) image.retry();
    if (!artifactId) delivery.retry();
  };
  // Redaction preserves the original identity for saved replay, never for a
  // network action whose destination the user cannot inspect.
  const hiddenRemote = remote && props.redacted;
  const remoteBlocked = remote && delivery.status === 'failed' && delivery.reason === 'not_allowed';
  const sourceActions = <span className="maka-markdown-image-actions">
    {(!hiddenRemote || artifactId) && <Button variant="ghost" size="sm" label={copy.imageRetry} onClick={retry} />}
    {remote && !hiddenRemote && <Link href={props.src} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>}
  </span>;
  let message: string | undefined;
  const remotePlaceholder = visible && remote && !artifactId;
  const needsConsent = remotePlaceholder && !hiddenRemote && delivery.status === 'requires_confirmation';
  const remoteUnavailable = remotePlaceholder && !hiddenRemote && !delivery.available;
  const remoteNotice = remotePlaceholder && (hiddenRemote || remoteUnavailable || needsConsent || remoteBlocked);
  if (failed) message = copy.imageLoadFailed;
  else if (!source) message = !visible ? copy.imageLoading
    : explicit && image.status === 'unavailable' ? copy.imageUnavailable
    : remotePlaceholder && hiddenRemote ? copy.imageRemoteRedacted
    : remoteUnavailable ? copy.imageRemoteUnavailable
    : needsConsent ? copy.imageRemoteConsent
    : delivery.status === 'failed' ? copy.imageArchiveFailure(delivery.reason)
    : delivery.status === 'pending' || artifactId ? copy.imageLoading : copy.imageUnsupported;
  const hasFrame = props.inline || !visible || !!source || !!artifactId || delivery.status === 'pending';
  return <span ref={anchor} className={`maka-markdown-image-resource${hasFrame ? props.inline ? ' maka-markdown-image-inline' : ' maka-markdown-image-frame' : ''}`}
    data-maka-image-state={message ? failed ? 'failed' : 'loading' : 'ready'}>
    {message && props.inline ? <Tooltip content={message}>
      <span className="maka-markdown-image-placeholder" role="status" aria-label={message}>
        {(failed || delivery.status === 'failed') && (!hiddenRemote || artifactId)
          ? <IconButton icon={<RotateCw size={14} />} size="sm" label={copy.imageRetry} onClick={retry} />
          : remoteNotice || delivery.status === 'unavailable' && visible
            ? <AlertTriangle size={14} aria-hidden="true" /> : <Spinner size="sm" shade="subtle" aria-hidden="true" />}
      </span>
    </Tooltip> : message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{hasFrame && !failed && !remoteNotice && delivery.status !== 'failed' && <Spinner size="sm" shade="subtle" aria-hidden="true" />} {message}</span>
      {(failed || delivery.status === 'failed') && sourceActions}
    </span> : source && <DisplayImage key={`${source}\0${attempt}`} src={source} alt={props.alt} onError={() => setFailedSource(source)} />}
    {(needsConsent || remoteUnavailable) && <span className="maka-markdown-image-actions">
      {needsConsent && <Button variant="ghost" size="sm" label={copy.imageLoad} onClick={delivery.confirmRemote} />}
      <Link href={props.src} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>
    </span>}
  </span>;
}
function DisplayImage(props: { src: string; alt: string; onError(): void }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const [loaded, setLoaded] = useState(false);
  const lightbox = useLightbox({ media: { src: props.src, alt: props.alt }, hasZoom: true });
  const trigger = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (lightbox.isOpen) return () => trigger.current?.focus();
  }, [lightbox.isOpen]);
  return <>
    <span ref={trigger} className="maka-markdown-image-preview maka-markdown-image-trigger"
        role="button" tabIndex={loaded ? 0 : -1} aria-label={copy.imageExpand(props.alt)}
        aria-haspopup="dialog" aria-disabled={!loaded}
        onClick={event => { event.preventDefault(); event.stopPropagation(); if (loaded) lightbox.open(); }}
        onKeyDown={event => {
          if (loaded && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); event.stopPropagation(); lightbox.open();
          }
        }}>
      {!loaded && <span className="maka-markdown-image-loading" role="status" aria-label={copy.imageLoading}><Spinner size="sm" shade="subtle" aria-hidden="true" /> <span className="maka-markdown-image-loading-label">{copy.imageLoading}</span></span>}
      <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
          className="maka-markdown-attachment-image" onLoad={() => setLoaded(true)} onError={props.onError} />
    </span>
    {lightbox.isOpen && lightbox.element}
  </>;
}
