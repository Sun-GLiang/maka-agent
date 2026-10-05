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

import type { BuildBuiltinToolsOptions } from './builtin-tools.js';
import {
  createBoundaryFilesystemExecutor,
  type FilesystemExecuteInput,
} from './filesystem-executor.js';
import { createLocalWorkspaceExecutor } from './workspace-executor.js';
/** The same filesystem boundary as Read, without model snapshots or tool execution. */
export function createImageFileReader(
  options: Pick<
    BuildBuiltinToolsOptions,
    'executor' | 'filesystemWorker' | 'permissionProfile'
  > = {},
) {
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: options.executor ?? createLocalWorkspaceExecutor(),
    ...(options.filesystemWorker ? { worker: options.filesystemWorker } : {}),
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
  });
  return async (input: Omit<FilesystemExecuteInput, 'operation'> & { path: string }) => {
    const { path, ...context } = input;
    const result = await filesystem.execute({ ...context, operation: { kind: 'read', path } });
    if (result.kind !== 'read_image') throw new Error('Not a supported raster image');
    return { bytes: result.bytes, mimeType: result.mimeType };
  };
}
