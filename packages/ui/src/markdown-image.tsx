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

import { useEffect, useRef, useState } from 'react';
import { useLightbox } from '@astryxdesign/core';
import { Link } from '@astryxdesign/core/Link';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { useAttachmentImage } from './attachment-image.js';
import { useImageDelivery } from './image-delivery.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';

/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function MarkdownImage(props: { src: string; alt: string }) {
  return <ImageResource key={props.src} {...props} />;
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
  const [attempt, setAttempt] = useState(0);
  const remote = isWebImage(props.src);
  const source = artifactId ? image.src : visible && remote && (!delivery.available || delivery.checked) ? props.src : undefined;
  const failed = !!source && failedSource === source || !!artifactId && image.status === 'failed';
  const retry = () => {
    setFailedSource(undefined); setAttempt(a => a + 1);
    if (artifactId) image.retry(); else delivery.retry();
  };
  const sourceActions = <span className="maka-markdown-image-actions">
    <button type="button" onClick={retry}>{copy.imageRetry}</button>
    {remote && <Link href={props.src} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>}
  </span>;
  let message: string | undefined;
  if (failed) message = copy.imageLoadFailed;
  else if (!source) message = !visible ? copy.imageLoading
    : explicit && image.status === 'unavailable' ? copy.imageUnavailable
    : delivery.status === 'failed' ? copy.imageArchiveFailure(delivery.reason)
    : delivery.status === 'pending' || artifactId ? copy.imageLoading : copy.imageUnsupported;
  return <span ref={anchor} className="maka-markdown-image-resource" data-maka-image-state={message ? failed ? 'failed' : 'loading' : 'ready'}>
    {message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{message}</span>
      {(failed || delivery.status === 'failed') && sourceActions}
    </span> : source && <DisplayImage key={`${source}\0${attempt}`} src={source} alt={props.alt} onError={() => setFailedSource(source)} />}
    {!explicit && delivery.status === 'pending' && remote && source && <span className="maka-markdown-image-saving" role="status">{copy.imageSaving}</span>}
    {!explicit && delivery.status === 'failed' && remote && source && !failed && <span className="maka-markdown-image-saving" role="status">
      {copy.imageArchiveFailure(delivery.reason)} {sourceActions}
    </span>}
  </span>;
}
function DisplayImage(props: { src: string; alt: string; onError(): void }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const [loaded, setLoaded] = useState(false);
  const lightbox = useLightbox({ media: { src: props.src, alt: props.alt }, hasZoom: true });
  return <>
    {!loaded && <span className="maka-markdown-image-loading" role="status">{copy.imageLoading}</span>}
    <button type="button" className="maka-markdown-image-preview" aria-label={copy.imageExpand(props.alt)} onClick={() => lightbox.open()}>
      <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className="maka-markdown-attachment-image" onLoad={() => setLoaded(true)} onError={props.onError} />
    </button>
    {lightbox.isOpen && lightbox.element}
  </>;
}
function isWebImage(source: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(source).protocol); } catch { return false; }
}
