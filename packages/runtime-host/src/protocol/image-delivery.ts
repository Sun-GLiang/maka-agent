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

import {
  IMAGE_DELIVERY_FAILURES,
  IMAGE_DELIVERY_IDENTITY_MAX_LENGTH,
  isImageDeliverySource,
  type ImageDeliveryRequest,
  type ImageDeliveryResult,
} from '@maka/core/image-delivery';
import { isCanonicalArtifactEntityId } from '@maka/core/artifacts';
import { requireExactRecord, requireEntityId, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
export interface ResolveImageDeliveryInput extends ImageDeliveryRequest {
  readonly sessionId: string;
}
export const IMAGE_DELIVERY_OPERATION_SPECS = {
  'artifact.image.resolve': defineOperation<
    ResolveImageDeliveryInput,
    ImageDeliveryResult,
    | 'host_not_ready'
    | 'host_draining'
    | 'operation_unavailable'
    | 'invalid_request'
    | 'not_found'
    | 'internal_failure'
  >({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'not_found',
      'internal_failure',
    ],
    decodeInput(value) {
      const v = requireExactRecord(value, 'image delivery request', [
        'sessionId',
        'turnId',
        'messageId',
        'source',
        ...(Object.hasOwn(requireRecord(value, 'image delivery request'), 'retry')
          ? ['retry']
          : []),
      ]);
      const text = (s: unknown, max: number) => {
        if (typeof s !== 'string' || !s.length || s.length > max || /[\u0000-\u001f\u007f]/.test(s))
          throw invalidProtocolFrame('Invalid image delivery identity');
        return s;
      };
      if (v.retry !== undefined && typeof v.retry !== 'boolean')
        throw invalidProtocolFrame('Invalid image retry flag');
      const source = (s: unknown) => {
        if (!isImageDeliverySource(s))
          throw invalidProtocolFrame('Invalid image delivery identity');
        return s;
      };
      return {
        sessionId: requireEntityId(v.sessionId, 'sessionId'),
        turnId: text(v.turnId, IMAGE_DELIVERY_IDENTITY_MAX_LENGTH),
        messageId: text(v.messageId, IMAGE_DELIVERY_IDENTITY_MAX_LENGTH),
        source: source(v.source),
        ...(v.retry === true ? { retry: true } : {}),
      };
    },
    decodeOutput(value) {
      const v = requireRecord(value, 'image delivery result');
      if (v.status === 'pending' || v.status === 'unavailable') {
        requireExactRecord(v, 'image delivery status', ['status']);
        return { status: v.status };
      }
      if (v.status === 'ready' && isCanonicalArtifactEntityId(v.artifactId)) {
        requireExactRecord(v, 'image delivery ready', ['status', 'artifactId']);
        return { status: 'ready', artifactId: v.artifactId };
      }
      if (v.status === 'failed' && IMAGE_DELIVERY_FAILURES.includes(v.reason as never)) {
        requireExactRecord(v, 'image delivery failure', ['status', 'reason']);
        return {
          status: 'failed',
          reason: v.reason as Extract<ImageDeliveryResult, { status: 'failed' }>['reason'],
        };
      }
      throw invalidProtocolFrame('Invalid image delivery result');
    },
  }),
} as const;
