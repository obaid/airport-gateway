(function () {
  "use strict";

  const key = "airport.demo.v1";
  const services = {
    gmail: { name: "Gmail", tools: ["search_email", "read_email", "send_email"] },
    drive: { name: "Google Drive", tools: ["search_files", "read_file", "share_file"] },
    calendar: { name: "Google Calendar", tools: ["list_events", "create_event", "delete_event"] },
    yahoo: { name: "Yahoo Mail", tools: ["search_email", "read_email", "send_email"] },
    instagram: { name: "Instagram", tools: ["list_posts", "read_comments", "publish_post"] },
    slack: { name: "Slack", tools: ["search_messages", "read_thread", "send_message"] },
    notion: { name: "Notion", tools: ["search_pages", "read_page", "update_page"] }
  };
  const providers = { muse: "Muse", duet: "Duet", dot: "Dots", custom: "Custom agent" };
  const lifetimes = {
    "12h": { label: "12 hours", hours: 12 },
    "7d": { label: "7 days", hours: 168 },
    "30d": { label: "30 days", hours: 720 },
    forever: { label: "Never expires", hours: null }
  };
  const defaultAccess = {
    gmail: ["Allow", "Allow", "Block"],
    drive: ["Allow", "Allow", "Ask"],
    calendar: ["Allow", "Ask", "Block"],
    yahoo: ["Allow", "Allow", "Block"],
    instagram: ["Allow", "Allow", "Ask"],
    slack: ["Allow", "Allow", "Ask"],
    notion: ["Allow", "Allow", "Ask"]
  };
  const id = () => globalThis.crypto?.randomUUID?.() ||
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let memory;

  function workspace(workspaceId, name) {
    const rules = {};
    for (const [service, { tools }] of Object.entries(services)) {
      rules[service] = Object.fromEntries(tools.map((tool, i) => [tool, defaultAccess[service][i]]));
    }
    return { id: workspaceId, name, connections: [], agents: [], rules, logs: [] };
  }

  function seed() {
    const work = workspace("work", "Work");
    const personal = workspace("personal", "Personal");
    const consulting = workspace("consulting", "Consulting");
    function populate(w, account, connected, enabled) {
      w.connections = connected.map(service => ({ id: w.id + "-" + service, service, account }));
      w.agents = enabled.map(provider => ({
        id: w.id + "-" + provider, provider, name: providers[provider], active: true
      }));
    }
    populate(work, "alex.morgan@example.com", ["gmail", "drive", "calendar", "slack"], ["muse", "duet", "dot"]);
    populate(personal, "alex.personal@example.com", ["yahoo", "calendar"], ["dot"]);
    populate(consulting, "hello.studio@example.com", ["notion", "drive"], ["duet"]);
    const entries = [
      [0, "muse", "gmail", "search_email", "Allowed", "Subject contains “launch brief”"],
      [0, "duet", "drive", "read_file", "Allowed", "Q4 launch brief"],
      [0, "dot", "gmail", "send_email", "Blocked", "Reply to studio@example.com"],
      [0, "muse", "calendar", "create_event", "Pending", "Design review"],
      [0, "dot", "slack", "read_thread", "Allowed", "#design · Launch notes"],
      [1, "muse", "calendar", "list_events", "Allowed", "Upcoming work week"],
      [1, "duet", "drive", "share_file", "Approved", "Prototype review notes"],
      [1, "dot", "gmail", "read_email", "Allowed", "Meeting follow-up"],
      [2, "dot", "slack", "send_message", "Denied", "#studio · Sprint update"],
      [2, "duet", "drive", "search_files", "Allowed", "Design references"],
      [2, "muse", "gmail", "search_email", "Allowed", "Messages from design@example.com"],
      [3, "muse", "gmail", "send_email", "Blocked", "Project update"],
      [3, "dot", "calendar", "list_events", "Allowed", "Product review"],
      [3, "duet", "slack", "search_messages", "Allowed", "Launch checklist"],
      [4, "duet", "drive", "read_file", "Allowed", "November roadmap"],
      [4, "muse", "calendar", "create_event", "Approved", "Studio planning"],
      [4, "dot", "gmail", "read_email", "Allowed", "Project intake"],
      [5, "dot", "calendar", "delete_event", "Blocked", "Partner sync"],
      [5, "muse", "slack", "search_messages", "Allowed", "Release timeline"],
      [6, "duet", "drive", "search_files", "Allowed", "Design handoff"],
      [6, "muse", "gmail", "read_email", "Allowed", "Weekly summary"]
    ];
    entries.forEach(([days, provider, service, tool, outcome, target], index) => {
      const now = new Date();
      const when = new Date(now);
      when.setDate(when.getDate() - days);
      if (days) {
        when.setHours(16 - index % 4, 50 - index % 43, 0, 0);
      } else {
        const midnight = new Date(now).setHours(0, 0, 0, 0);
        when.setTime(Math.max(midnight, now.getTime() - (index * 17 + 2) * 60000));
      }
      work.logs.push({
        id: "work-request-" + (index + 1), at: when.toISOString(),
        agent: providers[provider], agentId: "work-" + provider,
        service, connectionId: "work-" + service, tool, outcome, target,
        detail: explanation(outcome), policy: work.rules[service][tool]
      });
    });
    work.logs.sort((a, b) => b.at.localeCompare(a.at));
    return { selected: "work", workspaces: [personal, work, consulting] };
  }

  function persist(data) {
    memory = data;
    try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* An in-memory demo still works. */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const restored = JSON.parse(raw);
        if (restored.workspaces?.some(w => w.id === restored.selected)) {
          memory = restored;
          return restored;
        }
      }
    } catch { /* Recover when storage is unavailable. */ }
    if (!memory) persist(seed());
    return memory;
  }
  function current(data) {
    return data.workspaces.find(w => w.id === data.selected);
  }
  function mutate(fn) {
    const data = load();
    const result = fn(current(data), data);
    persist(data);
    return result;
  }
  function required(value, field) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Enter " + field + ".");
    return value.trim();
  }
  function knownTool(service, tool) {
    return Object.hasOwn(services, service) && services[service].tools.includes(tool);
  }
  function explanation(outcome) {
    return ({
      Allowed: "Allowed by the workspace policy.",
      Blocked: "Blocked by the workspace policy.",
      Pending: "Waiting for your approval.",
      Approved: "Approved by you.",
      Denied: "Denied by you."
    })[outcome];
  }
  function agentStatus(agent) {
    if (!agent) return "Revoked";
    // Existing sample agents predate duration selection and keep their access.
    if (agent.lifetime && agent.lifetime !== "forever" && !(Date.parse(agent.expiresAt) > Date.now())) return "Expired";
    return agent.active ? "Active" : "Paused";
  }
  function blockedReason(w, agent, connection, tool) {
    const status = agentStatus(agent);
    if (status === "Expired") return "This agent’s sample access has expired.";
    if (status !== "Active") return "This agent no longer has access to the workspace.";
    if (!connection) return "This connection is no longer available.";
    if (!knownTool(connection.service, tool)) return "This connection does not provide that tool.";
    if (!["Allow", "Ask"].includes(policy(w,connection,tool))) return explanation("Blocked");
    return "";
  }

  function policy(w,connection,tool) {
    return connection?.rules?.[tool] || w.rules[connection?.service]?.[tool] || "Block";
  }
  function findConnection(w,connectionId) {
    const connection = w.connections.find(item => item.id === connectionId);
    if (!connection) throw new Error("This connection is no longer available.");
    return connection;
  }
  globalThis.DB = {
    services, providers, lifetimes, agentStatus,
    policy, serviceName(key) {
      if (Object.hasOwn(services,key)) return services[key].name;
      return load().workspaces.flatMap(w => w.connections).find(c => c.service === key)?.serviceName || key;
    },
    w: () => current(load()),
    workspaces: () => load().workspaces,
    select(workspaceId) {
      return mutate((_, data) => {
        const selected = data.workspaces.find(w => w.id === workspaceId);
        if (!selected) throw new Error("Workspace not found.");
        data.selected = selected.id;
        return selected;
      });
    },
    createWorkspace(name) {
      return mutate((_, data) => {
        const created = workspace(id(), required(name, "a workspace name"));
        data.workspaces.push(created);
        data.selected = created.id;
        return created;
      });
    },
    addConnection(service, account, serviceName) {
      return mutate(w => {
        if (!Object.hasOwn(services, service) && (!/^[a-z0-9_-]{1,160}$/.test(service) || !serviceName)) throw new Error("Unknown service.");
        const label = required(account, "an account");
        const existing = w.connections.find(c => c.service === service && c.account.toLowerCase() === label.toLowerCase());
        if (existing) return existing;
        const rules = Object.fromEntries((services[service]?.tools || []).map(tool => [tool,"Block"]));
        const connection = { id: id(), service, account: label, rules,serviceName:services[service]?.name || String(serviceName) };
        w.connections.push(connection);
        return connection;
      });
    },
    renameConnection(connectionId,account) {
      return mutate(w => {
        const c = findConnection(w,connectionId), label = required(account,"an account label");
        if (w.connections.some(other => other.id !== c.id && other.service === c.service && other.account.toLowerCase() === label.toLowerCase())) {
          throw new Error("An account with that label already exists.");
        }
        for (const entry of w.logs) if (entry.connectionId === connectionId && !entry.account) entry.account = c.account;
        c.account = label;
      });
    },
    removeConnection(connectionId) {
      return mutate(w => {
        const connection = findConnection(w,connectionId);
        for (const entry of w.logs) if (entry.connectionId === connectionId && !entry.account) entry.account = connection.account;
        w.connections = w.connections.filter(c => c.id !== connectionId);
      });
    },
    savePolicies(changes) {
      return mutate(w => {
        for (const {connectionId,tool,value} of changes) {
          const c = findConnection(w,connectionId);
          if (!knownTool(c.service,tool) || !["Allow","Ask","Block"].includes(value)) throw new Error("Choose a valid tool and policy.");
        }
        for (const {connectionId,tool,value} of changes) {
          const c = findConnection(w,connectionId);
          (c.rules ||= {...w.rules[c.service]})[tool] = value;
        }
      });
    },
    addAgent(name, provider, workspaceIds = [], lifetime = "30d") {
      return mutate((w, data) => {
        if (!Object.hasOwn(providers, provider)) throw new Error("Unknown agent provider.");
        if (!Object.hasOwn(lifetimes, lifetime)) throw new Error("Choose a valid access duration.");
        const label = required(name, "an agent name");
        if (!Array.isArray(workspaceIds)) throw new Error("Choose workspaces from the list.");
        const selected = new Set(workspaceIds);
        if (selected.size !== workspaceIds.length) throw new Error("Choose each workspace only once.");
        selected.add(w.id);
        const targets = data.workspaces.filter(space => selected.has(space.id));
        if (targets.length !== selected.size) throw new Error("One of the workspaces no longer exists.");
        const duplicate = targets.find(space => space.agents.some(a => a.name.toLowerCase() === label.toLowerCase()));
        if (duplicate) throw new Error("An agent named " + label + " already exists in " + duplicate.name + ". Choose another name.");
        const hours = lifetimes[lifetime].hours;
        const expiresAt = hours === null ? null : new Date(Date.now() + hours*3600000).toISOString();
        const agent = { id: id(), name: label, provider, active: true, lifetime, expiresAt };
        for (const space of targets) space.agents.push({ ...agent });
        return agent;
      });
    },
    agentWorkspaces(agentId) {
      return load().workspaces
        .filter(space => space.agents.some(agent => agent.id === agentId))
        .map(({ id, name }) => ({ id, name }));
    },
    toggleAgent(agentId) {
      return mutate(w => {
        const agent = w.agents.find(a => a.id === agentId);
        if (!agent) throw new Error("Agent not found.");
        if (agentStatus(agent) === "Expired") throw new Error("This agent’s sample access has expired.");
        agent.active = !agent.active;
        return agent;
      });
    },
    revokeAgent(agentId) {
      return mutate(w => {
        if (!w.agents.some(a => a.id === agentId)) throw new Error("Agent not found in this workspace.");
        w.agents = w.agents.filter(a => a.id !== agentId);
      });
    },
    rule(service, tool, value) {
      return mutate(w => {
        if (!knownTool(service, tool) || !["Allow", "Ask", "Block"].includes(value)) {
          throw new Error("Unknown tool or policy.");
        }
        w.rules[service][tool] = value;
        return value;
      });
    },
    run(agentId, connectionId, tool, target = "") {
      return mutate(w => {
        const agent = w.agents.find(a => a.id === agentId);
        const connection = w.connections.find(c => c.id === connectionId);
        if (!agent || !connection) throw new Error("Select an agent and connection in this workspace.");
        const blocked = blockedReason(w, agent, connection, tool);
        let outcome = "Blocked";
        if (!blocked) outcome = policy(w,connection,tool) === "Ask" ? "Pending" : "Allowed";
        const log = {
          id: id(), at: new Date().toISOString(), agent: agent.name, agentId,
          service: connection.service, connectionId, tool, outcome, target: String(target || ""),
          policy: policy(w,connection,tool), account:connection.account,
          detail: blocked || explanation(outcome)
        };
        w.logs.unshift(log);
        return log;
      });
    },
    resolve(logId, approved) {
      return mutate(w => {
        const log = w.logs.find(entry => entry.id === logId);
        if (!log) throw new Error("Request not found.");
        if (log.outcome !== "Pending") return log;
        if (typeof approved !== "boolean") throw new Error("Choose approve or deny.");
        const agent = w.agents.find(a => a.id === log.agentId);
        const connection = w.connections.find(c => c.id === log.connectionId);
        const blocked = blockedReason(w, agent, connection, log.tool);
        log.outcome = approved ? (blocked ? "Blocked" : "Approved") : "Denied";
        log.detail = approved && blocked ? blocked : explanation(log.outcome);
        return log;
      });
    }
  };
})();
