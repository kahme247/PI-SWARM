const text = (description) => ({ type: 'string', description });
const integer = (description, minimum = 0) => ({ type: 'integer', minimum, description });
export const manageSchema = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['status', 'models', 'add', 'model', 'kill', 'title', 'channel'] },
    all: { type: 'boolean', description: 'For models: list every model add accepts, not just the suggested ones.' },
    name: text('Unique lowercase worker name, group prefix, or coordinator for model selection.'),
    brief: text('Self-contained public assignment: ownership, constraints, context and acceptance criteria.'),
    model: text('provider/model-id. Omit to inherit the calling member model.'),
    title: text('Swarm title, coordinator only.'),
    n: integer('Number of homogeneous numbered workers, mutually exclusive with tasks.', 1),
    tasks: { type: 'array', minItems: 1, items: text('One assignment per numbered worker; brief contains shared instructions.') },
    fork: text('Member whose persisted context to fork, including coordinator.'),
    workspace: { type: 'string', enum: ['inherit', 'share', 'branch'], description: 'Shared cwd, separate Git worktree at HEAD, or isolated local clone at HEAD.' },
    channels: { type: 'array', items: text('Existing channel subscription.') },
    op: { type: 'string', enum: ['create', 'list', 'subscribe', 'unsubscribe', 'archive'] },
    channel: text('Channel name; main is always visible.'),
    topic: text('Channel purpose.'),
  },
};
export const postSchema = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: { text: text('Public board post. @name, @group, @#channel and @all wake recipients. Cite #seq instead of copying reports.'), channel: text('Defaults to first subscribed area channel, otherwise main.') },
};
export const readSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    since: integer('Return oldest visible posts after this cursor; omitted returns the most recent posts.'),
    limit: { ...integer('Maximum posts to return; default 20.', 1), maximum: 1000 },
    seqs: { type: 'array', items: integer('Exact post sequence', 1), description: 'Return exactly these posts, ignoring since and limit.' },
    channel: text('Read one channel, * for every channel, or omit for your subscribed view.'),
    status: { type: 'boolean', description: 'Return member states and read/wait/post cursors.' },
  },
};
export const waitSchema = {
  type: 'object', additionalProperties: false, required: ['since'],
  properties: {
    since: integer('Highest sequence actually read, NOT an unread board head. Already-posted matching messages return immediately.'),
    mentions_only: { type: 'boolean', default: true, description: 'Wait for a mention, or false for any visible post. Waiting consumes no model tokens.' },
    timeout_ms: integer('Optional wait timeout in milliseconds; omit for no timeout.', 1),
  },
};
export const toolSpecs = [
  { name: 'swarm', label: 'Swarm', description: 'Manage persistent native pi workers: status/models/add/model/kill/title/channel. Workers start fresh unless fork is set; briefs are public. Kill is permanent. Workers may manage only themselves and helpers as permitted.', parameters: manageSchema, method: 'manage' },
  { name: 'post_message', label: 'Post to swarm', description: 'Post to the shared ordered board. Mentions wake recipients across channels. Address only agents who should act next. Final result: @coordinator [done] evidence.', parameters: postSchema, method: 'post' },
  { name: 'read_board', label: 'Read swarm board', description: 'Read durable board posts with pagination, exact sequence lookup and channel views, or inspect member status. Preserve your last actually-read sequence.', parameters: readSchema, method: 'read' },
  { name: 'swarm_wait', label: 'Wait for swarm', description: 'Park until a matching board message arrives without polling or model requests. Pass your last actually-read sequence to avoid missed wakeups.', parameters: waitSchema, method: 'wait' },
];
