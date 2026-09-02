import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import type {
  SessionCatalogProjection,
  SessionConfigurationPatch,
} from '@maka/runtime-host/protocol';

interface AcpSessionConfigSpec {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly options: readonly (readonly [string, string])[];
}

const PERMISSION_SPEC = {
  id: 'permission_mode', name: 'Permission mode', category: '_maka/permission_mode',
  options: [['explore', 'Explore'], ['ask', 'Ask'], ['bypass', 'Bypass']],
} as const satisfies AcpSessionConfigSpec;
const THINKING_SPEC = {
  id: 'thinking_level', name: 'Thinking level', category: 'thought_level',
  options: [['default', 'Default'], ['off', 'Off'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']],
} as const satisfies AcpSessionConfigSpec;
const COLLABORATION_SPEC = {
  id: 'collaboration_mode', name: 'Collaboration mode', category: 'mode',
  options: [['agent', 'Agent'], ['plan', 'Plan']],
} as const satisfies AcpSessionConfigSpec;
const ORCHESTRATION_SPEC = {
  id: 'orchestration_mode', name: 'Orchestration mode', category: '_maka/orchestration_mode',
  options: [['default', 'Default'], ['swarm', 'Swarm'], ['graph', 'Graph']],
} as const satisfies AcpSessionConfigSpec;

const CONFIG_SPECS = [PERMISSION_SPEC, THINKING_SPEC, COLLABORATION_SPEC, ORCHESTRATION_SPEC] as const;

export function projectAcpSessionConfigOptions(session: SessionCatalogProjection): SessionConfigOption[] {
  return [
    configOption(PERMISSION_SPEC, session.permissionMode),
    configOption(THINKING_SPEC, session.thinkingLevel ?? 'default'),
    configOption(COLLABORATION_SPEC, session.collaborationMode),
    configOption(ORCHESTRATION_SPEC, session.orchestrationMode),
  ];
}

function configOption(spec: AcpSessionConfigSpec, currentValue: string): SessionConfigOption {
  return {
    type: 'select', id: spec.id, name: spec.name, category: spec.category, currentValue,
    options: spec.options.map(([value, name]) => ({ value, name })),
  };
}

export class AcpSessionConfigInputError extends Error {
  readonly name = 'AcpSessionConfigInputError';
  constructor(readonly field: 'configId' | 'value', readonly reason: 'unsupported' | 'invalid_type') {
    super(`Invalid ACP Session configuration ${field}`);
  }
}

export function validateAcpSessionConfigOptionRequest(
  request: SetSessionConfigOptionRequest,
): asserts request is SetSessionConfigOptionRequest & { readonly value: string } {
  const spec = CONFIG_SPECS.find(({ id }) => id === request.configId);
  if (!spec) throw new AcpSessionConfigInputError('configId', 'unsupported');
  if (typeof request.value !== 'string') throw new AcpSessionConfigInputError('value', 'invalid_type');
  if (!spec.options.some(([value]) => value === request.value)) {
    throw new AcpSessionConfigInputError('value', 'unsupported');
  }
}

export function createAcpSessionConfigPatch(request: SetSessionConfigOptionRequest): SessionConfigurationPatch {
  validateAcpSessionConfigOptionRequest(request);
  switch (request.configId) {
    case 'permission_mode': return { permissionMode: request.value as SessionConfigurationPatch['permissionMode'] };
    case 'thinking_level': return { thinkingLevel: request.value === 'default' ? null : request.value as Exclude<SessionConfigurationPatch['thinkingLevel'], null | undefined> };
    case 'collaboration_mode': return { collaborationMode: request.value as SessionConfigurationPatch['collaborationMode'] };
    case 'orchestration_mode': return { orchestrationMode: request.value as SessionConfigurationPatch['orchestrationMode'] };
    default: throw new AcpSessionConfigInputError('configId', 'unsupported');
  }
}
