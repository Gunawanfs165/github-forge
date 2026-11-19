// GraphQL v4 handler for the forge: POST /api/graphql.
// No external GraphQL library: a small tokenizer + recursive-descent parser
// produces a simple AST, and a schema-driven executor resolves it against the
// shared Store (the same store REST/MCP/git use, so ids and objects agree).
// Viewer is always adaiversen (id 1000); any non-empty Bearer token is the viewer.
import { randomUUID } from 'node:crypto';
import {
  VIEWER,
  NOW,
  nodeId,
  decodeNodeId,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';

const REQUEST_ID_HEADER = 'x-github-request-id';

// ---------------------------------------------------------------------------
// Types / schema
// ---------------------------------------------------------------------------

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT' | 'INTERFACE' | 'UNION';
  description?: string | null;
  fields?: { name: string; description?: string | null; args?: { name: string; type: string }[]; type: string }[];
  enumValues?: { name: string; description?: string | null }[];
  inputFields?: { name: string; description?: string | null; type: string }[];
  possibleTypes?: string[];
}

function obj(name: string, fields: TypeDef['fields']): TypeDef {
  return { name, kind: 'OBJECT', fields };
}
function enm(name: string, values: string[]): TypeDef {
  return { name, kind: 'ENUM', enumValues: values.map((v) => ({ name: v })) };
}
function scalar(name: string): TypeDef {
  return { name, kind: 'SCALAR' };
}
function inputObj(name: string, inputFields: TypeDef['inputFields']): TypeDef {
  return { name, kind: 'INPUT_OBJECT', inputFields };
}

const SCHEMA: Record<string, TypeDef> = {};
function def(t: TypeDef): void { SCHEMA[t.name] = t; }

def(obj('Query', [
  { name: 'viewer', type: 'User' },
  { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
  { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
  { name: 'search', type: 'SearchResultItemConnection', args: [{ name: 'query', type: 'String!' }, { name: 'type', type: 'SearchType!' }, { name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
  { name: '__schema', type: '__Schema' },
  { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
]));
def(obj('Mutation', [
  { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
  { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
  { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
  { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
  { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
]));
def(obj('User', [
  { name: 'id', type: 'ID!' },
  { name: 'login', type: 'String!' },
  { name: 'name', type: 'String' },
  { name: 'email', type: 'String' },
  { name: 'avatarUrl', type: 'URI' },
  { name: 'url', type: 'URI' },
  { name: 'htmlUrl', type: 'URI' },
  { name: 'databaseId', type: 'Int' },
  { name: 'type', type: 'String' },
]));
def(obj('Repository', [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String!' },
  { name: 'nameWithOwner', type: 'String!' },
  { name: 'owner', type: 'User' },
  { name: 'defaultBranchRef', type: 'Ref' },
  { name: 'viewerPermission', type: 'RepositoryPermission' },
  { name: 'hasIssuesEnabled', type: 'Boolean' },
  { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
  { name: 'issues', type: 'IssueConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[IssueState!]' }, { name: 'orderBy', type: 'IssueOrder' }] },
  { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
  { name: 'pullRequests', type: 'PullRequestConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'states', type: '[PullRequestState!]' }, { name: 'orderBy', type: 'IssueOrder' }] },
  { name: 'description', type: 'String' },
  { name: 'url', type: 'URI' },
  { name: 'htmlUrl', type: 'URI' },
  { name: 'createdAt', type: 'DateTime' },
  { name: 'updatedAt', type: 'DateTime' },
  { name: 'pushedAt', type: 'DateTime' },
  { name: 'fork', type: 'Boolean' },
  { name: 'private', type: 'Boolean' },
  { name: 'isPrivate', type: 'Boolean' },
  { name: 'hasWikiEnabled', type: 'Boolean' },
  { name: 'hasProjectsEnabled', type: 'Boolean' },
  { name: 'defaultBranch', type: 'String' },
]));
def(obj('Ref', [
  { name: 'id', type: 'ID!' },
  { name: 'name', type: 'String!' },
  { name: 'prefix', type: 'String!' },
  { name: 'target', type: 'GitObject' },
]));
def(obj('Issue', [
  { name: 'id', type: 'ID!' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'state', type: 'IssueState!' },
  { name: 'body', type: 'String' },
  { name: 'url', type: 'URI' },
  { name: 'htmlUrl', type: 'URI' },
  { name: 'createdAt', type: 'DateTime' },
  { name: 'updatedAt', type: 'DateTime' },
  { name: 'closedAt', type: 'DateTime' },
  { name: 'author', type: 'User' },
  { name: 'authorAssociation', type: 'String' },
  { name: 'comments', type: 'IssueCommentConnection' },
  { name: 'labels', type: 'LabelConnection' },
  { name: 'assignees', type: 'UserConnection' },
  { name: 'repository', type: 'Repository' },
  { name: 'locked', type: 'Boolean' },
]));
def(obj('PullRequest', [
  { name: 'id', type: 'ID!' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'state', type: 'PullRequestState!' },
  { name: 'body', type: 'String' },
  { name: 'url', type: 'URI' },
  { name: 'htmlUrl', type: 'URI' },
  { name: 'createdAt', type: 'DateTime' },
  { name: 'updatedAt', type: 'DateTime' },
  { name: 'closedAt', type: 'DateTime' },
  { name: 'mergedAt', type: 'DateTime' },
  { name: 'merged', type: 'Boolean!' },
  { name: 'mergeable', type: 'MergeableState!' },
  { name: 'headRefName', type: 'String!' },
  { name: 'baseRefName', type: 'String!' },
  { name: 'headRefOid', type: 'GitObjectID' },
  { name: 'baseRefOid', type: 'GitObjectID' },
  { name: 'files', type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
  { name: 'author', type: 'User' },
  { name: 'authorAssociation', type: 'String' },
  { name: 'repository', type: 'Repository' },
  { name: 'isDraft', type: 'Boolean' },
  { name: 'draft', type: 'Boolean' },
]));
def(obj('IssueConnection', [
  { name: 'nodes', type: '[Issue]' },
  { name: 'edges', type: '[IssueEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('PullRequestConnection', [
  { name: 'nodes', type: '[PullRequest]' },
  { name: 'edges', type: '[PullRequestEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('SearchResultItemConnection', [
  { name: 'nodes', type: '[SearchResultItem]' },
  { name: 'edges', type: '[SearchResultItemEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('IssueEdge', [{ name: 'node', type: 'Issue' }, { name: 'cursor', type: 'String!' }]));
def(obj('PullRequestEdge', [{ name: 'node', type: 'PullRequest' }, { name: 'cursor', type: 'String!' }]));
def(obj('SearchResultItemEdge', [{ name: 'node', type: 'SearchResultItem' }, { name: 'cursor', type: 'String!' }]));
def(obj('PageInfo', [
  { name: 'hasNextPage', type: 'Boolean!' },
  { name: 'hasPreviousPage', type: 'Boolean!' },
  { name: 'startCursor', type: 'String' },
  { name: 'endCursor', type: 'String' },
]));
def(obj('PullRequestChangedFileConnection', [
  { name: 'nodes', type: '[PullRequestChangedFile]' },
  { name: 'edges', type: '[PullRequestChangedFileEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('PullRequestChangedFileEdge', [{ name: 'node', type: 'PullRequestChangedFile' }, { name: 'cursor', type: 'String!' }]));
def(obj('PullRequestChangedFile', [
  { name: 'path', type: 'String!' },
  { name: 'filename', type: 'String!' },
  { name: 'additions', type: 'Int!' },
  { name: 'deletions', type: 'Int!' },
  { name: 'changes', type: 'Int!' },
  { name: 'status', type: 'String' },
]));
def(obj('IssueComment', [
  { name: 'id', type: 'ID!' },
  { name: 'body', type: 'String!' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'DateTime' },
  { name: 'updatedAt', type: 'DateTime' },
  { name: 'url', type: 'URI' },
  { name: 'htmlUrl', type: 'URI' },
]));
def(obj('CommentEdge', [{ name: 'node', type: 'IssueComment' }, { name: 'cursor', type: 'String!' }]));
def(obj('IssueCommentConnection', [
  { name: 'nodes', type: '[IssueComment]' },
  { name: 'edges', type: '[CommentEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('Label', [
  { name: 'id', type: 'ID!' },
  { name: 'name', type: 'String!' },
  { name: 'color', type: 'String' },
  { name: 'description', type: 'String' },
  { name: 'url', type: 'URI' },
]));
def(obj('LabelConnection', [
  { name: 'nodes', type: '[Label]' },
  { name: 'edges', type: '[LabelEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('LabelEdge', [{ name: 'node', type: 'Label' }, { name: 'cursor', type: 'String!' }]));
def(obj('UserConnection', [
  { name: 'nodes', type: '[User]' },
  { name: 'edges', type: '[UserEdge]' },
  { name: 'totalCount', type: 'Int!' },
  { name: 'pageInfo', type: 'PageInfo!' },
]));
def(obj('UserEdge', [{ name: 'node', type: 'User' }, { name: 'cursor', type: 'String!' }]));
def(obj('CreateIssuePayload', [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }]));
def(obj('CloseIssuePayload', [{ name: 'issue', type: 'Issue' }, { name: 'clientMutationId', type: 'String' }]));
def(obj('CreatePullRequestPayload', [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }]));
def(obj('MergePullRequestPayload', [{ name: 'pullRequest', type: 'PullRequest' }, { name: 'clientMutationId', type: 'String' }]));
def(obj('AddCommentPayload', [
  { name: 'commentEdge', type: 'CommentEdge' },
  { name: 'comment', type: 'IssueComment' },
  { name: 'subject', type: 'Issue' },
  { name: 'clientMutationId', type: 'String' },
]));
def(obj('__Schema', [
  { name: 'queryType', type: '__Type' },
  { name: 'mutationType', type: '__Type' },
  { name: 'subscriptionType', type: '__Type' },
  { name: 'types', type: '[__Type!]' },
  { name: 'directives', type: '[__Directive!]' },
  { name: 'description', type: 'String' },
]));
def(obj('__Type', [
  { name: 'name', type: 'String' },
  { name: 'kind', type: '__TypeKind' },
  { name: 'description', type: 'String' },
  { name: 'fields', type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
  { name: 'enumValues', type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
  { name: 'inputFields', type: '[__InputValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
  { name: 'interfaces', type: '[__Type!]' },
  { name: 'possibleTypes', type: '[__Type!]' },
  { name: 'ofType', type: '__Type' },
  { name: 'specifiedByURL', type: 'String' },
]));
def(obj('__Field', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'args', type: '[__InputValue!]' },
  { name: 'type', type: '__Type!' },
  { name: 'isDeprecated', type: 'Boolean!' },
  { name: 'deprecationReason', type: 'String' },
]));
def(obj('__InputValue', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'type', type: '__Type!' },
  { name: 'defaultValue', type: 'String' },
]));
def(obj('__EnumValue', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'isDeprecated', type: 'Boolean!' },
  { name: 'deprecationReason', type: 'String' },
]));
def(obj('__Directive', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'locations', type: '[__DirectiveLocation!]' },
  { name: 'args', type: '[__InputValue!]' },
  { name: 'isRepeatable', type: 'Boolean!' },
]));
def(enm('IssueState', ['OPEN', 'CLOSED']));
def(enm('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']));
def(enm('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']));
def(enm('OrderDirection', ['ASC', 'DESC']));
def(enm('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']));
def(enm('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']));
def(enm('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE']));
def(enm('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']));
def(enm('__TypeKind', ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']));
def(enm('__DirectiveLocation', ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT']));
def(scalar('String')); def(scalar('Int')); def(scalar('Float')); def(scalar('Boolean'));
def(scalar('ID')); def(scalar('DateTime')); def(scalar('URI')); def(scalar('GitObjectID'));
def({ name: 'Node', kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] });
def({ name: 'SearchResultItem', kind: 'UNION', possibleTypes: ['Issue', 'PullRequest', 'Repository', 'User'] });
def({ name: 'GitObject', kind: 'INTERFACE', fields: [{ name: 'oid', type: 'GitObjectID' }] });
def(inputObj('CreateIssueInput', [
  { name: 'repositoryId', type: 'ID!' }, { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' }, { name: 'clientMutationId', type: 'String' },
  { name: 'labelIds', type: '[ID!]' }, { name: 'assigneeIds', type: '[ID!]' },
]));
def(inputObj('CloseIssueInput', [
  { name: 'issueId', type: 'ID!' }, { name: 'stateReason', type: 'String' }, { name: 'clientMutationId', type: 'String' },
]));
def(inputObj('CreatePullRequestInput', [
  { name: 'repositoryId', type: 'ID!' }, { name: 'baseRefName', type: 'String!' },
  { name: 'headRefName', type: 'String!' }, { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' }, { name: 'draft', type: 'Boolean' },
  { name: 'clientMutationId', type: 'String' },
]));
def(inputObj('MergePullRequestInput', [
  { name: 'pullRequestId', type: 'ID!' }, { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
  { name: 'commitHeadline', type: 'String' }, { name: 'commitBody', type: 'String' },
  { name: 'clientMutationId', type: 'String' },
]));
def(inputObj('AddCommentInput', [
  { name: 'subjectId', type: 'ID!' }, { name: 'body', type: 'String!' }, { name: 'clientMutationId', type: 'String' },
]));
def(inputObj('IssueOrder', [
  { name: 'field', type: 'IssueOrderField!' }, { name: 'direction', type: 'OrderDirection!' },
]));

// ---------------------------------------------------------------------------
// Tokenizer + parser (minimal GraphQL)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]!:=$@&|'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      // block string """...""" or normal "..."
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3; continue;
      }
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e ?? '';
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      if (j >= src.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1; continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j])) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: src.slice(i, j) } : { kind: 'int', value: src.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j; continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface DirectiveNode { name: string; args: { name: string; value: ValueNode }[] }
interface FieldNode {
  kind: 'field'; alias: string | null; name: string;
  args: { name: string; value: ValueNode }[]; directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode { kind: 'spread'; name: string; directives: DirectiveNode[] }
interface InlineFragmentNode {
  kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
interface OperationNode {
  kind: 'operation'; operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; defaultValue: ValueNode | null }[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected "${v}" but got ${t.kind} ${JSON.stringify(t.value)}`);
  }
  private matchPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected name but got ${t.kind} ${JSON.stringify(t.value)}`);
    return t.value;
  }
  private matchName(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'name' && t.value === v) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }
  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], directives: [], selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      const directives = this.parseDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, directives, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      if (!this.matchName('on')) throw new Error('Expected "on" in fragment definition');
      const typeCondition = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected ${t.kind} ${JSON.stringify(t.value)} at document top level`);
  }
  private parseVariableDefinitions(): { name: string; defaultValue: ValueNode | null }[] {
    if (!this.matchPunct('(')) return [];
    const defs: { name: string; defaultValue: ValueNode | null }[] = [];
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    return defs;
  }
  private parseType(): void {
    if (this.matchPunct('[')) { this.parseType(); this.expectPunct(']'); }
    else this.expectName();
    this.matchPunct('!');
  }
  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.matchPunct('}')) sels.push(this.parseSelection());
    return sels;
  }
  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) { alias = first; name = this.expectName(); }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
  private parseArguments(): { name: string; value: ValueNode }[] {
    if (!this.matchPunct('(')) return [];
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }
  private parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      dirs.push({ name: this.expectName(), args: this.parseArguments() });
    }
    return dirs;
  }
  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value token ${t.kind} ${JSON.stringify(t.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Tagged =
  | { __type: 'User'; user: any }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; repo: Repo; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: any }
  | { __type: 'Label'; label: any }
  | { __type: 'ChangedFile'; file: any }
  | { __type: 'Connection'; connType: string; items: Tagged[]; totalCount: number }
  | { __type: 'Edge'; edgeType: string; node: Tagged | null; cursor: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: '__Schema' }
  | { __type: '__Type'; def: TypeDef }
  | { __type: '__Field'; field: NonNullable<TypeDef['fields']>[number] }
  | { __type: '__InputValue'; input: { name: string; type: string; description?: string | null } }
  | { __type: '__EnumValue'; value: { name: string; description?: string | null } }
  | { __type: '__Directive'; name: string; locations: string[] }
  | { __type: 'Payload'; payloadType: string; data: Record<string, unknown> };

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string; path?: (string | number)[] }[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx.variables);
  return out;
}

function directivesSkip(directives: DirectiveNode[], ctx: Ctx): boolean {
  for (const d of directives) {
    const args: Record<string, unknown> = {};
    for (const a of d.args) args[a.name] = resolveValue(a.value, ctx.variables);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}
function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const s = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10);
  } catch { /* fall through */ }
  const n = parseInt(cursor, 10);
  return Number.isFinite(n) ? n : -1;
}

function connectionWithPageInfo(connType: string, items: Tagged[], args: Record<string, unknown>): Tagged & { page: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = decodeCursor(args.after);
  const start = after + 1;
  const page = items.slice(start, start + Math.max(0, first));
  const end = start + page.length;
  const edges: Tagged[] = page.map((node, i) => ({ __type: 'Edge', edgeType: edgeTypeFor(connType), node, cursor: encodeCursor(start + i) } as Tagged));
  const pageInfo = {
    hasNextPage: end < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length ? (edges[0] as { cursor: string }).cursor : null,
    endCursor: edges.length ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
  };
  return { __type: 'Connection', connType, items: edges, totalCount: items.length, page: pageInfo } as Tagged & { page: typeof pageInfo };
}

function edgeTypeFor(connType: string): string {
  if (connType === 'SearchResultItemConnection') return 'SearchResultItemEdge';
  if (connType === 'PullRequestChangedFileConnection') return 'PullRequestChangedFileEdge';
  return connType.replace('Connection', 'Edge');
}

function baseTypeName(t: string): string {
  return t.replace(/[\[\]!]/g, '');
}

function typeDefFor(name: string): TypeDef {
  return SCHEMA[name] ?? { name, kind: 'SCALAR' };
}

// --- store lookups ---

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.id === id) return r;
  return undefined;
}
function findRepoByNodeId(store: Store, gid: string): Repo | undefined {
  const d = decodeNodeId(gid);
  if (!d || d.kind !== 'Repository') return undefined;
  return findRepoById(store, d.id);
}
function findIssueByNodeId(store: Store, gid: string): { repo: Repo; issue: Issue } | undefined {
  const d = decodeNodeId(gid);
  if (!d || d.kind !== 'Issue') return undefined;
  for (const r of store.repos.values()) {
    const issue = r.issues.find((i) => i.id === d.id);
    if (issue) return { repo: r, issue };
  }
  return undefined;
}
function findPullByNodeId(store: Store, gid: string): { repo: Repo; pull: Pull } | undefined {
  const d = decodeNodeId(gid);
  if (!d || d.kind !== 'PullRequest') return undefined;
  for (const r of store.repos.values()) {
    const pull = r.pulls.find((p) => p.id === d.id);
    if (pull) return { repo: r, pull };
  }
  return undefined;
}

function userTag(user: any): Tagged {
  return { __type: 'User', user };
}
function viewerTag(store: Store): Tagged {
  return userTag(store.viewerUser());
}
function issueStateGql(state: string): string { return state === 'closed' ? 'CLOSED' : 'OPEN'; }
function pullStateGql(p: Pull): string {
  if (p.merged) return 'MERGED';
  return p.state === 'closed' ? 'CLOSED' : 'OPEN';
}
function mergeableGql(p: Pull): string {
  return p.mergeable ? 'MERGEABLE' : 'CONFLICTING';
}

// --- git helpers for PR files / merge ---

function commitTreeOid(store: Store, repo: Repo, commitOid: string | null | undefined): string | null {
  if (!commitOid) return null;
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return store.parseCommit(obj.data).tree;
}

function computePullFiles(store: Store, repo: Repo, p: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  if (p._files && p._files.length > 0) return p._files;
  const baseOid = repo.branches.get(p.base.ref) ?? p.base.sha;
  const headOid = repo.branches.get(p.head.ref) ?? p.head.sha;
  const baseTree = commitTreeOid(store, repo, baseOid);
  const headTree = commitTreeOid(store, repo, headOid);
  if (!baseTree || !headTree) return p._files ?? [];
  const baseFiles = store.flattenTree(repo, baseTree);
  const headFiles = store.flattenTree(repo, headTree);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const [path, f] of headFiles) {
    const b = baseFiles.get(path);
    if (!b) out.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
    else if (b.oid !== f.oid) out.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) out.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

function mergePull(store: Store, repo: Repo, p: Pull): void {
  const baseRef = p.base.ref;
  const headRef = p.head.ref;
  const baseOid = repo.branches.get(baseRef) ?? p.base.sha ?? null;
  const headOid = repo.branches.get(headRef) ?? p.head.sha ?? null;
  let mergeSha: string | null = headOid;
  if (baseOid && headOid && baseOid !== headOid) {
    const headTree = commitTreeOid(store, repo, headOid);
    if (headTree) {
      const epoch = Math.floor(Date.parse(NOW) / 1000);
      const ident = `ada iversen <adaiversen@example.invalid> ${epoch} +0000`;
      const content = `tree ${headTree}\nparent ${baseOid}\nauthor ${ident}\ncommitter ${ident}\n\n${p.title}\n`;
      mergeSha = store.putObject(repo, 'commit', Buffer.from(content, 'utf8'));
      repo.branches.set(baseRef, mergeSha);
      repo.refs.set(`refs/heads/${baseRef}`, mergeSha);
    }
  }
  p.merge_commit_sha = mergeSha;
  p.merged = true;
  p.state = 'closed';
  p.merged_at = NOW;
  p.closed_at = NOW;
  p.updated_at = NOW;
}

// --- field resolution ---

type Resolved = { value: unknown; childType: string | null };

function resolveField(typeName: string, src: Tagged | null, field: FieldNode, ctx: Ctx): Resolved {
  const args = argsOf(field, ctx);
  const store = ctx.store;
  const nullRes: Resolved = { value: null, childType: null };

  // Root Query
  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer': return { value: viewerTag(store), childType: 'User' };
      case 'repository': {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string'
          ? store.getRepo(args.owner, args.name) : undefined;
        return repo ? { value: { __type: 'Repository', repo } as Tagged, childType: 'Repository' } : nullRes;
      }
      case 'node': {
        if (typeof args.id !== 'string') return nullRes;
        const d = decodeNodeId(args.id);
        if (!d) return nullRes;
        if (d.kind === 'Repository') {
          const repo = findRepoById(store, d.id);
          return repo ? { value: { __type: 'Repository', repo } as Tagged, childType: 'Repository' } : nullRes;
        }
        if (d.kind === 'Issue') {
          const hit = findIssueByNodeId(store, args.id);
          return hit ? { value: { __type: 'Issue', repo: hit.repo, issue: hit.issue } as Tagged, childType: 'Issue' } : nullRes;
        }
        if (d.kind === 'PullRequest') {
          const hit = findPullByNodeId(store, args.id);
          return hit ? { value: { __type: 'PullRequest', repo: hit.repo, pull: hit.pull } as Tagged, childType: 'PullRequest' } : nullRes;
        }
        if (d.kind === 'User' && d.id === VIEWER.id) return { value: viewerTag(store), childType: 'User' };
        return nullRes;
      }
      case 'search': {
        const q = typeof args.query === 'string' ? args.query : '';
        const type = typeof args.type === 'string' ? args.type : 'ISSUE';
        const repoMatch = /repo:([^\s]+)/.exec(q);
        const terms = q.replace(/repo:[^\s]+/g, '').trim().toLowerCase();
        let items: Tagged[] = [];
        if (type === 'REPOSITORY') {
          for (const r of store.repos.values()) {
            if (repoMatch && `${r.full_name}`.toLowerCase() !== repoMatch[1].toLowerCase()) continue;
            if (terms && !r.name.toLowerCase().includes(terms) && !r.full_name.toLowerCase().includes(terms)) continue;
            items.push({ __type: 'Repository', repo: r } as Tagged);
          }
        } else {
          for (const r of store.repos.values()) {
            if (repoMatch && r.full_name.toLowerCase() !== repoMatch[1].toLowerCase()) continue;
            for (const issue of r.issues) {
              if (terms && !issue.title.toLowerCase().includes(terms) && !(issue.body ?? '').toLowerCase().includes(terms)) continue;
              items.push({ __type: 'Issue', repo: r, issue } as Tagged);
            }
          }
        }
        return { value: connectionWithPageInfo('SearchResultItemConnection', items, args), childType: 'SearchResultItemConnection' };
      }
      case '__schema': return { value: { __type: '__Schema' } as Tagged, childType: '__Schema' };
      case '__type': {
        if (typeof args.name !== 'string') return nullRes;
        const d = SCHEMA[args.name];
        return d ? { value: { __type: '__Type', def: d } as Tagged, childType: '__Type' } : nullRes;
      }
    }
    return nullRes;
  }

  // Mutations
  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repo = typeof input.repositoryId === 'string' ? findRepoByNodeId(store, input.repositoryId) : undefined;
        if (!repo) { ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.` }); return nullRes; }
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const id = store.nextId();
        const issue: Issue = {
          id, number: repo.nextIssue++, title, body, state: 'open', labels: [],
          user: store.viewerUser(), assignees: [], comments: [],
          created_at: NOW, updated_at: NOW, closed_at: null,
          html_url: `/${repo.full_name}/issues/${repo.nextIssue - 1}`,
          url: `/api/v3/repos/${repo.full_name}/issues/${repo.nextIssue - 1}`,
          comments_url: `/api/v3/repos/${repo.full_name}/issues/${repo.nextIssue - 1}/comments`,
          labels_url: `/api/v3/repos/${repo.full_name}/issues/${repo.nextIssue - 1}/labels`,
          repository_url: `/api/v3/repos/${repo.full_name}`,
          node_id: nodeId('Issue', id),
        };
        repo.issues.push(issue);
        const payload: Tagged = { __type: 'Payload', payloadType: 'CreateIssuePayload', data: { issue: { __type: 'Issue', repo, issue } as Tagged, clientMutationId: input.clientMutationId ?? null } };
        return { value: payload, childType: 'CreateIssuePayload' };
      }
      case 'closeIssue': {
        const hit = typeof input.issueId === 'string' ? findIssueByNodeId(store, input.issueId) : undefined;
        if (!hit) { ctx.errors.push({ message: `Could not resolve to an Issue with the id of '${String(input.issueId)}'.` }); return nullRes; }
        hit.issue.state = 'closed';
        hit.issue.closed_at = NOW;
        hit.issue.updated_at = NOW;
        const payload: Tagged = { __type: 'Payload', payloadType: 'CloseIssuePayload', data: { issue: { __type: 'Issue', repo: hit.repo, issue: hit.issue } as Tagged, clientMutationId: input.clientMutationId ?? null } };
        return { value: payload, childType: 'CloseIssuePayload' };
      }
      case 'createPullRequest': {
        const repo = typeof input.repositoryId === 'string' ? findRepoByNodeId(store, input.repositoryId) : undefined;
        if (!repo) { ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${String(input.repositoryId)}'.` }); return nullRes; }
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.default_branch;
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const id = store.nextId();
        const number = repo.nextPull++;
        const headSha = repo.branches.get(headRef) ?? '';
        const baseSha = repo.branches.get(baseRef) ?? '';
        const pull: Pull = {
          id, number, title, body, state: 'open', merged: false,
          mergeable: Boolean(headSha && baseSha), merge_commit_sha: null,
          head: { ref: headRef, sha: headSha, label: `${repo.owner.login}:${headRef}`, repo: store.repoJson(repo) },
          base: { ref: baseRef, sha: baseSha, label: `${repo.owner.login}:${baseRef}`, repo: store.repoJson(repo) },
          user: store.viewerUser(), created_at: NOW, updated_at: NOW, closed_at: null, merged_at: null,
          html_url: `/${repo.full_name}/pull/${number}`,
          url: `/api/v3/repos/${repo.full_name}/pulls/${number}`,
          node_id: nodeId('PullRequest', id),
          _files: [], _headTreeOid: null, _baseTreeOid: null,
        };
        pull._files = computePullFiles(store, repo, pull);
        repo.pulls.push(pull);
        const payload: Tagged = { __type: 'Payload', payloadType: 'CreatePullRequestPayload', data: { pullRequest: { __type: 'PullRequest', repo, pull } as Tagged, clientMutationId: input.clientMutationId ?? null } };
        return { value: payload, childType: 'CreatePullRequestPayload' };
      }
      case 'mergePullRequest': {
        const hit = typeof input.pullRequestId === 'string' ? findPullByNodeId(store, input.pullRequestId) : undefined;
        if (!hit) { ctx.errors.push({ message: `Could not resolve to a PullRequest with the id of '${String(input.pullRequestId)}'.` }); return nullRes; }
        mergePull(store, hit.repo, hit.pull);
        const payload: Tagged = { __type: 'Payload', payloadType: 'MergePullRequestPayload', data: { pullRequest: { __type: 'PullRequest', repo: hit.repo, pull: hit.pull } as Tagged, clientMutationId: input.clientMutationId ?? null } };
        return { value: payload, childType: 'MergePullRequestPayload' };
      }
      case 'addComment': {
        const body = typeof input.body === 'string' ? input.body : '';
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const issueHit = findIssueByNodeId(store, subjectId);
        if (issueHit) {
          const cid = issueHit.repo.nextCommentId++;
          const comment = {
            id: cid, body, user: store.viewerUser(), created_at: NOW, updated_at: NOW,
            html_url: `/${issueHit.repo.full_name}/issues/${issueHit.issue.number}#issuecomment-${cid}`,
            url: `/api/v3/repos/${issueHit.repo.full_name}/issues/comments/${cid}`,
            node_id: nodeId('IssueComment', cid),
          };
          issueHit.issue.comments.push(comment as never);
          const node: Tagged = { __type: 'IssueComment', repo: issueHit.repo, issue: issueHit.issue, comment };
          const edge: Tagged = { __type: 'Edge', edgeType: 'CommentEdge', node, cursor: encodeCursor(issueHit.issue.comments.length - 1) };
          const payload: Tagged = { __type: 'Payload', payloadType: 'AddCommentPayload', data: { commentEdge: edge, comment: node, subject: { __type: 'Issue', repo: issueHit.repo, issue: issueHit.issue } as Tagged, clientMutationId: input.clientMutationId ?? null } };
          return { value: payload, childType: 'AddCommentPayload' };
        }
        const pullHit = findPullByNodeId(store, subjectId);
        if (pullHit) {
          // Comments on a pull request are stored as issue comments on the matching issue number if any;
          // otherwise answer the comment without a REST-visible home.
          const cid = store.nextId();
          const comment = { id: cid, body, user: store.viewerUser(), created_at: NOW, updated_at: NOW, html_url: '', url: '', node_id: nodeId('IssueComment', cid) };
          const node: Tagged = { __type: 'IssueComment', repo: pullHit.repo, issue: pullHit.repo.issues.find((i) => i.number === pullHit.pull.number) ?? ({} as Issue), comment };
          const edge: Tagged = { __type: 'Edge', edgeType: 'CommentEdge', node, cursor: encodeCursor(0) };
          const payload: Tagged = { __type: 'Payload', payloadType: 'AddCommentPayload', data: { commentEdge: edge, comment: node, subject: { __type: 'PullRequest', repo: pullHit.repo, pull: pullHit.pull } as Tagged, clientMutationId: input.clientMutationId ?? null } };
          return { value: payload, childType: 'AddCommentPayload' };
        }
        ctx.errors.push({ message: `Could not resolve to a subject with the id of '${subjectId}'.` });
        return nullRes;
      }
    }
    return nullRes;
  }

  if (!src) return nullRes;

  // Payload objects
  if (src.__type === 'Payload') {
    const v = src.data[field.name];
    if (v === undefined) return nullRes;
    const defField = SCHEMA[src.payloadType]?.fields?.find((f) => f.name === field.name);
    return { value: v, childType: defField ? baseTypeName(defField.type) : null };
  }

  // Repository
  if (src.__type === 'Repository') {
    const r = src.repo;
    switch (field.name) {
      case 'id': return { value: nodeId('Repository', r.id), childType: null };
      case 'databaseId': return { value: r.id, childType: null };
      case 'name': return { value: r.name, childType: null };
      case 'nameWithOwner': return { value: r.full_name, childType: null };
      case 'owner': return { value: userTag(r.owner), childType: 'User' };
      case 'defaultBranchRef': return { value: { __type: 'Ref', repo: r, name: r.default_branch } as Tagged, childType: 'Ref' };
      case 'defaultBranch': return { value: r.default_branch, childType: null };
      case 'viewerPermission': return { value: 'ADMIN', childType: null };
      case 'hasIssuesEnabled': return { value: true, childType: null };
      case 'hasWikiEnabled': return { value: true, childType: null };
      case 'hasProjectsEnabled': return { value: true, childType: null };
      case 'description': return { value: r.description, childType: null };
      case 'url': return { value: r.url, childType: null };
      case 'htmlUrl': return { value: r.html_url, childType: null };
      case 'createdAt': return { value: r.created_at, childType: null };
      case 'updatedAt': return { value: r.updated_at, childType: null };
      case 'pushedAt': return { value: r.pushed_at, childType: null };
      case 'fork': return { value: r.fork, childType: null };
      case 'private': return { value: r.private, childType: null };
      case 'isPrivate': return { value: r.private, childType: null };
      case 'issue': {
        const issue = r.issues.find((i) => i.number === args.number);
        return issue ? { value: { __type: 'Issue', repo: r, issue } as Tagged, childType: 'Issue' } : nullRes;
      }
      case 'issues': {
        let list = [...r.issues];
        if (Array.isArray(args.states)) {
          const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const dir = orderBy?.direction === 'ASC' ? 1 : -1;
        // CREATED_AT / UPDATED_AT: every issue shares the fixed NOW timestamp, so
        // the tie-break (number) decides; DESC = number DESC, ASC = number ASC.
        list.sort((a, b) => dir * (a.number - b.number));
        const items: Tagged[] = list.map((issue) => ({ __type: 'Issue', repo: r, issue } as Tagged));
        return { value: connectionWithPageInfo('IssueConnection', items, args), childType: 'IssueConnection' };
      }
      case 'pullRequest': {
        const pull = r.pulls.find((p) => p.number === args.number);
        return pull ? { value: { __type: 'PullRequest', repo: r, pull } as Tagged, childType: 'PullRequest' } : nullRes;
      }
      case 'pullRequests': {
        let list = [...r.pulls];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states as string[]);
          list = list.filter((p) => wanted.has(pullStateGql(p)));
        } else {
          list = list.filter((p) => p.state === 'open');
        }
        list.sort((a, b) => a.number - b.number);
        const items: Tagged[] = list.map((pull) => ({ __type: 'PullRequest', repo: r, pull } as Tagged));
        return { value: connectionWithPageInfo('PullRequestConnection', items, args), childType: 'PullRequestConnection' };
      }
    }
    return nullRes;
  }

  // User
  if (src.__type === 'User') {
    const u = src.user;
    switch (field.name) {
      case 'id': return { value: u.node_id ?? nodeId('User', u.id), childType: null };
      case 'login': return { value: u.login, childType: null };
      case 'name': return { value: u.name ?? u.login, childType: null };
      case 'email': return { value: u.email ?? null, childType: null };
      case 'avatarUrl': return { value: u.avatar_url ?? '', childType: null };
      case 'url': return { value: u.url ?? '', childType: null };
      case 'htmlUrl': return { value: u.html_url ?? '', childType: null };
      case 'databaseId': return { value: u.id, childType: null };
      case 'type': return { value: u.type ?? 'User', childType: null };
    }
    return nullRes;
  }

  // Ref
  if (src.__type === 'Ref') {
    switch (field.name) {
      case 'id': return { value: nodeId('Ref', src.repo.id), childType: null };
      case 'name': return { value: src.name, childType: null };
      case 'prefix': return { value: 'refs/heads/', childType: null };
      case 'target': return nullRes;
    }
    return nullRes;
  }

  // Issue
  if (src.__type === 'Issue') {
    const i = src.issue;
    switch (field.name) {
      case 'id': return { value: i.node_id, childType: null };
      case 'number': return { value: i.number, childType: null };
      case 'title': return { value: i.title, childType: null };
      case 'state': return { value: issueStateGql(i.state), childType: null };
      case 'body': return { value: i.body, childType: null };
      case 'url': return { value: i.url, childType: null };
      case 'htmlUrl': return { value: i.html_url, childType: null };
      case 'createdAt': return { value: i.created_at, childType: null };
      case 'updatedAt': return { value: i.updated_at, childType: null };
      case 'closedAt': return { value: i.closed_at, childType: null };
      case 'author': return { value: userTag(i.user), childType: 'User' };
      case 'authorAssociation': return { value: 'OWNER', childType: null };
      case 'locked': return { value: false, childType: null };
      case 'repository': return { value: { __type: 'Repository', repo: src.repo } as Tagged, childType: 'Repository' };
      case 'comments': {
        const items: Tagged[] = i.comments.map((c) => ({ __type: 'IssueComment', repo: src.repo, issue: i, comment: c } as Tagged));
        return { value: connectionWithPageInfo('IssueCommentConnection', items, args), childType: 'IssueCommentConnection' };
      }
      case 'labels': {
        const items: Tagged[] = i.labels.map((l) => ({ __type: 'Label', label: l } as Tagged));
        return { value: connectionWithPageInfo('LabelConnection', items, args), childType: 'LabelConnection' };
      }
      case 'assignees': {
        const items: Tagged[] = (i.assignees ?? []).map((a) => userTag(a));
        return { value: connectionWithPageInfo('UserConnection', items, args), childType: 'UserConnection' };
      }
    }
    return nullRes;
  }

  // PullRequest
  if (src.__type === 'PullRequest') {
    const p = src.pull;
    switch (field.name) {
      case 'id': return { value: p.node_id, childType: null };
      case 'number': return { value: p.number, childType: null };
      case 'title': return { value: p.title, childType: null };
      case 'state': return { value: pullStateGql(p), childType: null };
      case 'body': return { value: p.body, childType: null };
      case 'url': return { value: p.url, childType: null };
      case 'htmlUrl': return { value: p.html_url, childType: null };
      case 'createdAt': return { value: p.created_at, childType: null };
      case 'updatedAt': return { value: p.updated_at, childType: null };
      case 'closedAt': return { value: p.closed_at, childType: null };
      case 'mergedAt': return { value: p.merged_at, childType: null };
      case 'merged': return { value: p.merged, childType: null };
      case 'mergeable': return { value: mergeableGql(p), childType: null };
      case 'headRefName': return { value: p.head.ref, childType: null };
      case 'baseRefName': return { value: p.base.ref, childType: null };
      case 'headRefOid': return { value: p.head.sha || null, childType: null };
      case 'baseRefOid': return { value: p.base.sha || null, childType: null };
      case 'author': return { value: userTag(p.user), childType: 'User' };
      case 'authorAssociation': return { value: 'OWNER', childType: null };
      case 'repository': return { value: { __type: 'Repository', repo: src.repo } as Tagged, childType: 'Repository' };
      case 'isDraft': return { value: false, childType: null };
      case 'draft': return { value: false, childType: null };
      case 'files': {
        const files = computePullFiles(store, src.repo, p);
        const items: Tagged[] = files.map((f) => ({ __type: 'ChangedFile', file: f } as Tagged));
        return { value: connectionWithPageInfo('PullRequestChangedFileConnection', items, args), childType: 'PullRequestChangedFileConnection' };
      }
    }
    return nullRes;
  }

  // Connection
  if (src.__type === 'Connection') {
    switch (field.name) {
      case 'nodes': {
        const nodes = (src.items as Tagged[]).map((e) => (e.__type === 'Edge' ? e.node : e));
        const defField = SCHEMA[src.connType]?.fields?.find((f) => f.name === 'nodes');
        return { value: nodes, childType: defField ? baseTypeName(defField.type) : null, };
      }
      case 'edges': return { value: src.items, childType: edgeTypeFor(src.connType) };
      case 'totalCount': return { value: src.totalCount, childType: null };
      case 'pageInfo': {
        const page = (src as unknown as { page?: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } }).page
          ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        return { value: { __type: 'PageInfo', ...page } as Tagged, childType: 'PageInfo' };
      }
    }
    return nullRes;
  }

  // Edge
  if (src.__type === 'Edge') {
    switch (field.name) {
      case 'node': {
        const defField = SCHEMA[src.edgeType]?.fields?.find((f) => f.name === 'node');
        return { value: src.node, childType: defField ? baseTypeName(defField.type) : null };
      }
      case 'cursor': return { value: src.cursor, childType: null };
    }
    return nullRes;
  }

  // PageInfo
  if (src.__type === 'PageInfo') {
    switch (field.name) {
      case 'hasNextPage': return { value: src.hasNextPage, childType: null };
      case 'hasPreviousPage': return { value: src.hasPreviousPage, childType: null };
      case 'startCursor': return { value: src.startCursor, childType: null };
      case 'endCursor': return { value: src.endCursor, childType: null };
    }
    return nullRes;
  }

  // ChangedFile
  if (src.__type === 'ChangedFile') {
    const f = src.file;
    switch (field.name) {
      case 'path': return { value: f.filename, childType: null };
      case 'filename': return { value: f.filename, childType: null };
      case 'additions': return { value: f.additions ?? 0, childType: null };
      case 'deletions': return { value: f.deletions ?? 0, childType: null };
      case 'changes': return { value: f.changes ?? 0, childType: null };
      case 'status': return { value: f.status ?? 'modified', childType: null };
    }
    return nullRes;
  }

  // IssueComment
  if (src.__type === 'IssueComment') {
    const c = src.comment;
    switch (field.name) {
      case 'id': return { value: c.node_id ?? nodeId('IssueComment', c.id), childType: null };
      case 'body': return { value: c.body, childType: null };
      case 'author': return { value: userTag(c.user), childType: 'User' };
      case 'createdAt': return { value: c.created_at, childType: null };
      case 'updatedAt': return { value: c.updated_at, childType: null };
      case 'url': return { value: c.url, childType: null };
      case 'htmlUrl': return { value: c.html_url, childType: null };
    }
    return nullRes;
  }

  // Label
  if (src.__type === 'Label') {
    const l = src.label;
    switch (field.name) {
      case 'id': return { value: nodeId('Label', l.id), childType: null };
      case 'name': return { value: l.name, childType: null };
      case 'color': return { value: l.color, childType: null };
      case 'description': return { value: l.description, childType: null };
      case 'url': return { value: l.url, childType: null };
    }
    return nullRes;
  }

  // Introspection: __Schema
  if (src.__type === '__Schema') {
    switch (field.name) {
      case 'queryType': return { value: { __type: '__Type', def: SCHEMA.Query! } as Tagged, childType: '__Type' };
      case 'mutationType': return { value: { __type: '__Type', def: SCHEMA.Mutation! } as Tagged, childType: '__Type' };
      case 'subscriptionType': return nullRes;
      case 'types': return { value: Object.values(SCHEMA).map((d) => ({ __type: '__Type', def: d } as Tagged)), childType: '__Type' };
      case 'directives': return {
        value: [
          { __type: '__Directive', name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] } as Tagged,
          { __type: '__Directive', name: 'include', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] } as Tagged,
          { __type: '__Directive', name: 'deprecated', locations: ['FIELD', 'ENUM_VALUE'] } as Tagged,
        ], childType: '__Directive',
      };
      case 'description': return { value: null, childType: null };
    }
    return nullRes;
  }

  // Introspection: __Type
  if (src.__type === '__Type') {
    const d = src.def;
    switch (field.name) {
      case 'name': return { value: d.name, childType: null };
      case 'kind': return { value: d.kind, childType: null };
      case 'description': return { value: d.description ?? null, childType: null };
      case 'fields': {
        const fields = (d.fields ?? []).map((f) => ({ __type: '__Field', field: f } as Tagged));
        return { value: fields, childType: '__Field' };
      }
      case 'enumValues': {
        const vals = (d.enumValues ?? []).map((v) => ({ __type: '__EnumValue', value: v } as Tagged));
        return { value: vals, childType: '__EnumValue' };
      }
      case 'inputFields': {
        const vals = (d.inputFields ?? []).map((f) => ({ __type: '__InputValue', input: f } as Tagged));
        return { value: vals, childType: '__InputValue' };
      }
      case 'interfaces': return { value: [], childType: '__Type' };
      case 'possibleTypes': return { value: (d.possibleTypes ?? []).map((n) => ({ __type: '__Type', def: typeDefFor(n) } as Tagged)), childType: '__Type' };
      case 'ofType': return nullRes;
      case 'specifiedByURL': return { value: null, childType: null };
    }
    return nullRes;
  }

  // Introspection: __Field
  if (src.__type === '__Field') {
    const f = src.field;
    switch (field.name) {
      case 'name': return { value: f.name, childType: null };
      case 'description': return { value: f.description ?? null, childType: null };
      case 'args': {
        const vals = (f.args ?? []).map((a) => ({ __type: '__InputValue', input: a } as Tagged));
        return { value: vals, childType: '__InputValue' };
      }
      case 'type': return { value: { __type: '__Type', def: typeDefFor(baseTypeName(f.type)) } as Tagged, childType: '__Type' };
      case 'isDeprecated': return { value: false, childType: null };
      case 'deprecationReason': return { value: null, childType: null };
    }
    return nullRes;
  }

  // Introspection: __InputValue
  if (src.__type === '__InputValue') {
    const inp = src.input;
    switch (field.name) {
      case 'name': return { value: inp.name, childType: null };
      case 'description': return { value: inp.description ?? null, childType: null };
      case 'type': return { value: { __type: '__Type', def: typeDefFor(baseTypeName(inp.type)) } as Tagged, childType: '__Type' };
      case 'defaultValue': return { value: null, childType: null };
    }
    return nullRes;
  }

  // Introspection: __EnumValue
  if (src.__type === '__EnumValue') {
    switch (field.name) {
      case 'name': return { value: src.value.name, childType: null };
      case 'description': return { value: src.value.description ?? null, childType: null };
      case 'isDeprecated': return { value: false, childType: null };
      case 'deprecationReason': return { value: null, childType: null };
    }
    return nullRes;
  }

  // Introspection: __Directive
  if (src.__type === '__Directive') {
    switch (field.name) {
      case 'name': return { value: src.name, childType: null };
      case 'description': return { value: null, childType: null };
      case 'locations': return { value: src.locations, childType: null };
      case 'args': return { value: [], childType: '__InputValue' };
      case 'isRepeatable': return { value: false, childType: null };
    }
    return nullRes;
  }

  return nullRes;
}

function fieldKnown(typeName: string, fieldName: string): boolean {
  if (fieldName === '__typename') return true;
  // __schema / __type are valid on Query (and on any type per spec for __typename only);
  // they are in the Query field list already.
  const def = SCHEMA[typeName];
  if (!def?.fields) return false;
  return def.fields.some((f) => f.name === fieldName);
}

function isTagged(v: unknown): v is Tagged {
  return v !== null && typeof v === 'object' && '__type' in (v as Record<string, unknown>);
}

function executeValue(value: unknown, childType: string | null, selectionSet: SelectionNode[] | null, ctx: Ctx): unknown {
  if (selectionSet === null || selectionSet === undefined) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    // A list of nodes: each element executes against the (singular) child type.
    return value.map((el) => executeValue(el, childType, selectionSet, ctx));
  }
  if (isTagged(value) && childType) {
    // Use the value's concrete type (Repository for a node(id:) hit, the edge
    // type for an Edge, the payload type for a mutation payload); the declared
    // child type is only the interface/union/payload name.
    const concrete =
      value.__type === 'Payload' ? childType
      : value.__type === 'Edge' ? ((value as { edgeType?: string }).edgeType ?? childType)
      : value.__type === 'Connection' ? ((value as { connType?: string }).connType ?? childType)
      : value.__type === 'ChangedFile' ? 'PullRequestChangedFile'
      : value.__type;
    return executeSelectionSet(concrete, value, selectionSet, ctx);
  }
  if (isTagged(value)) return executeSelectionSet(value.__type, value, selectionSet, ctx);
  return value;
}

function executeSelectionSet(typeName: string, src: Tagged | null, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      if (directivesSkip(sel.directives, ctx)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (!frag) { ctx.errors.push({ message: `Unknown fragment "${sel.name}".` }); continue; }
      if (frag.typeCondition && frag.typeCondition !== typeName && frag.typeCondition !== 'Node' && frag.typeCondition !== 'SearchResultItem') continue;
      Object.assign(out, executeSelectionSet(typeName, src, frag.selectionSet, ctx));
      continue;
    }
    if (sel.kind === 'inline') {
      if (directivesSkip(sel.directives, ctx)) continue;
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== 'Node' && sel.typeCondition !== 'SearchResultItem') continue;
      Object.assign(out, executeSelectionSet(typeName, src, sel.selectionSet, ctx));
      continue;
    }
    // field
    if (directivesSkip(sel.directives, ctx)) continue;
    const responseKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[responseKey] = typeName; continue; }
    if (!fieldKnown(typeName, sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const { value, childType } = resolveField(typeName, src, sel, ctx);
    out[responseKey] = executeValue(value, childType, sel.selectionSet, ctx);
  }
  return out;
}

function executeOperation(store: Store, op: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): { data: unknown; errors: { message: string }[] } {
  const ctx: Ctx = { store, variables: { ...variables }, fragments, errors: [] };
  // Apply variable-definition defaults for variables the caller did not send.
  for (const vd of op.variableDefinitions) {
    if (!(vd.name in ctx.variables) || ctx.variables[vd.name] === undefined) {
      if (vd.defaultValue) ctx.variables[vd.name] = resolveValue(vd.defaultValue, variables);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, op.selectionSet, ctx);
  return { data, errors: ctx.errors };
}

function runOneOperation(store: Store, body: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'No query string was present' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document' }] };
  }
  let op: OperationNode | undefined;
  const operationName = body.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    op = operations.find((o) => o.name === operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (operations.length === 1) {
    op = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const result = executeOperation(store, op, fragments, variables);
  return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function sendJson(res: any, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    [REQUEST_ID_HEADER]: `req-${randomUUID()}`,
  });
  res.end(text);
}

function pathOf(req: any): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function isAuthenticated(req: any): boolean {
  const auth = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof auth !== 'string') return false;
  const m = /^Bearer\s+(.+)$/.exec(auth.trim());
  return Boolean(m && m[1]!.trim() !== '');
}

/**
 * Handle POST /api/graphql. Returns true when the path is /api/graphql (the
 * request was answered here), false otherwise so the caller can route it
 * elsewhere. `rawBody` is the request body bytes as already read by the
 * caller; when it is empty the body is read from `req` (not used by app.ts).
 */
export async function handleGraphQL(store: Store, req: any, res: any, rawBody: Buffer): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql' && path !== '/api/graphql/') return false;

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  if ((req.method ?? 'POST') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  let parsed: unknown;
  try {
    const text = rawBody.length > 0 ? rawBody.toString('utf8') : '';
    if (text.trim() === '') throw new Error('empty body');
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    const results = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? runOneOperation(store, entry as Record<string, unknown>)
        : { data: null, errors: [{ message: 'Invalid operation in batch' }] },
    );
    sendJson(res, 200, results);
    return true;
  }

  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  sendJson(res, 200, runOneOperation(store, parsed as Record<string, unknown>));
  return true;
}
