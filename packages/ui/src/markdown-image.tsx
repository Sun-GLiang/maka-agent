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
import { Button, IconButton, Spinner, useLightbox } from '@astryxdesign/core';
import { Maximize2 } from './icons.js';
import { Link } from '@astryxdesign/core/Link';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { useAttachmentImage } from './attachment-image.js';
import { useImageDelivery } from './image-delivery.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';

const ImageSourceContext = createContext<(source: string) => string>((source) => source);
export function MarkdownImageSourceProvider(props: { text: string; children: ReactNode }) {
  const resolve = useMemo(() => createMarkdownImageSourceResolver(props.text), [props.text]);
  return <ImageSourceContext.Provider value={resolve}>{props.children}</ImageSourceContext.Provider>;
}

/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function MarkdownImage(props: { src: string; alt: string }) {
  const source = useContext(ImageSourceContext)(props.src);
  return <ImageResource key={source} src={source} alt={props.alt} />;
}
function ImageResource(props: { src: string; alt: string }) {
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
  // Keep measured badge geometry across URL-to-attachment switches and retries.
  const [compactSize, setCompactSize] = useState<{ width: number; height: number }>();
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
  const hasFrame = (!visible || !!source || !!artifactId || delivery.status === 'pending') && !(compactSize && failed);
  return <span ref={anchor} className={`maka-markdown-image-resource${hasFrame ? compactSize ? ' maka-markdown-image-compact' : ' maka-markdown-image-frame' : ''}`}
    style={hasFrame && compactSize ? { minWidth: compactSize.width, minHeight: compactSize.height } : undefined}
    data-maka-image-state={message ? failed ? 'failed' : 'loading' : 'ready'}>
    {message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{hasFrame && !failed && delivery.status !== 'failed' && <Spinner size="sm" shade="subtle" aria-hidden="true" />} {message}</span>
      {(failed || delivery.status === 'failed') && sourceActions}
    </span> : source && <DisplayImage key={`${source}\0${attempt}`} src={source} alt={props.alt} compactSize={compactSize} onError={() => setFailedSource(source)}
      onLoad={(width, height) => setCompactSize(width <= 320 && height <= 64 ? { width, height } : undefined)} />}
    {!explicit && delivery.status === 'pending' && remote && source && <span className="maka-markdown-image-saving" role="status">{copy.imageSaving}</span>}
    {!explicit && delivery.status === 'failed' && remote && source && !failed && <span className="maka-markdown-image-saving" role="status">
      {copy.imageArchiveFailure(delivery.reason)} {sourceActions}
    </span>}
  </span>;
}
function DisplayImage(props: { src: string; alt: string; compactSize?: { width: number; height: number }; onError(): void; onLoad(width: number, height: number): void }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const [loaded, setLoaded] = useState(false);
  const lightbox = useLightbox({ media: { src: props.src, alt: props.alt }, hasZoom: true });
  return <>
    <span className="maka-markdown-image-preview" style={props.compactSize ? { width: props.compactSize.width, height: props.compactSize.height } : undefined}>
      {!loaded && <span className="maka-markdown-image-loading" role="status"><Spinner size="sm" shade="subtle" aria-hidden="true" /> {copy.imageLoading}</span>}
      <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
          className="maka-markdown-attachment-image" onLoad={event => {
            setLoaded(true); props.onLoad(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
          }} onError={props.onError} />
      {loaded && <span className="maka-markdown-image-expand">
        <IconButton icon={<Maximize2 size={16} />} size="sm" label={copy.imageExpand(props.alt)} onClick={() => lightbox.open()} />
      </span>}
    </span>
    {lightbox.isOpen && lightbox.element}
  </>;
}
function isWebImage(source: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(source).protocol); } catch { return false; }
}
