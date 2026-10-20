import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

type User = { id: string; email: string };
type Project = { id: string; name: string; description: string; role: string; created_at: string };
type Node = { id: string; parent_id: string | null; title: string; sort_order: number; archived: number };
type Source = { id: string; title: string; kind: string; body: string; file_name: string | null; analysis_status: string; analysis_error: string | null; topic_count?: number; author_email: string | null; created_at: string };
type Item = { id: string; node_id: string | null; title: string; summary: string; location: string; discipline: string; supplier: string; responsible: string; status: string; due_date: string; attention: number; confidence: number; source_title: string | null; latest_update: string | null; latest_update_at: string | null; latest_update_author: string | null; update_count: number; created_at: string; updated_at: string };
type Member = { id: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; created_at: string };
type Update = { id: string; summary: string; evidence: string; previous_status: string | null; new_status: string; created_at: string; source_title: string | null; author_email: string | null };
type HistoryEntry = { id: string; item_id: string; summary: string; evidence: string; created_at: string; source_title: string | null; author_email: string | null };
type TopicSummary = { node_id: string; summary: string; important_change: string; analysis_status: string; analysis_error: string | null; generated_at: string | null };
type State = { user: User; projects: Project[]; project?: Project; nodes?: Node[]; sources?: Source[]; items?: Item[]; members?: Member[]; invitations?: Invitation[]; topicSummaries?: TopicSummary[] };
type View = "overview" | "items" | "sources" | "structure" | "people" | "reports";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...options, headers: { ...(options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a operação");
  return data as T;
}

const post = <T,>(path: string, body: unknown, method = "POST") => api<T>(path, { method, body: JSON.stringify(body) });
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString("pt-BR") : "—";
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
function categoryOptions(nodes: Node[]) {
  const active = nodes.filter((node) => !node.archived);
  const byId = new Map(active.map((node) => [node.id, node]));
  return active.map((node) => {
    const titles = [node.title];
    const seen = new Set([node.id]);
    let parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    while (parent && !seen.has(parent.id)) {
      titles.unshift(parent.title);
      seen.add(parent.id);
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
    }
    return { id: node.id, label: titles.join(" › ") };
  }).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}
const statusName: Record<string, string> = { pendente: "Pendente", em_andamento: "Em andamento", bloqueado: "Bloqueado", concluido: "Concluído", informativo: "Informativo" };
const views: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Relatório vivo", icon: "◫" },
  { id: "items", label: "Assuntos", icon: "▤" },
  { id: "sources", label: "Conversa", icon: "▧" },
  { id: "structure", label: "Estrutura", icon: "⌘" },
  { id: "people", label: "Pessoas", icon: "♙" },
  { id: "reports", label: "Matrizes e PDF", icon: "▣" },
];

function isOverdue(item: Item) {
  return Boolean(item.due_date && item.status !== "concluido" && new Date(`${item.due_date}T23:59:59`) < new Date());
}

function Status({ item }: { item: Item }) {
  return <span className={`status status-${item.status}`}>{statusName[item.status] || item.status}{isOverdue(item) && <strong> · Atrasado</strong>}</span>;
}

export default function App() {
  const inviteToken = new URLSearchParams(window.location.search).get("convite");
  const [state, setState] = useState<State | null>(null);
  const [projectId, setProjectId] = useState(localStorage.getItem("organizador_project") || "");
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [composerFocus, setComposerFocus] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const refresh = useCallback(async (id = projectId) => {
    try {
      let next: State;
      try { next = await api<State>(`/api/state${id ? `?projectId=${encodeURIComponent(id)}` : ""}`); }
      catch (cause) {
        if (!id || !(cause instanceof Error) || cause.message !== "Projeto não autorizado") throw cause;
        next = await api<State>("/api/state");
        id = "";
      }
      if (!id && next.projects.length) {
        const fallback = next.projects[0].id;
        setProjectId(fallback);
        localStorage.setItem("organizador_project", fallback);
        next = await api<State>(`/api/state?projectId=${encodeURIComponent(fallback)}`);
      }
      setState(next);
      setSyncedAt(new Date().toISOString());
      setError("");
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("login")) setState(null);
      else if (cause instanceof Error && cause.message.includes("Sessão")) setState(null);
      else setError(cause instanceof Error ? cause.message : "Falha ao carregar dados");
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (!inviteToken) void refresh(); else setLoading(false); }, [refresh, inviteToken]);

  useEffect(() => {
    if (!state || !projectId || inviteToken) return;
    const updateIfVisible = () => { if (!document.hidden) void refresh(projectId); };
    const interval = window.setInterval(updateIfVisible, 60_000);
    document.addEventListener("visibilitychange", updateIfVisible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", updateIfVisible); };
  }, [Boolean(state), projectId, inviteToken, refresh]);

  const hasProcessingSource = Boolean(state?.sources?.some((source) => ["pending", "processing"].includes(source.analysis_status)) || state?.topicSummaries?.some((summary) => ["pending", "processing"].includes(summary.analysis_status)));
  useEffect(() => {
    if (!hasProcessingSource || !projectId) return;
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(projectId); }, 8000);
    return () => window.clearInterval(interval);
  }, [hasProcessingSource, projectId, refresh]);

  const chooseProject = (id: string) => { setProjectId(id); localStorage.setItem("organizador_project", id); setView("overview"); void refresh(id); };
  const after = async (message = "Alterações salvas") => { await refresh(); setNotice(message); setTimeout(() => setNotice(""), 5000); };
  const openItem = async (item: Item) => {
    setSelectedItem(item);
    try { const result = await api<{ updates: Update[] }>(`/api/projects/${projectId}/items/${item.id}/updates`); setUpdates(result.updates); }
    catch { setUpdates([]); }
  };

  if (inviteToken) return <InviteScreen token={inviteToken} />;
  if (loading) return <div className="center-screen"><div className="spinner" /><p>Carregando seu espaço de trabalho...</p></div>;
  if (!state) return <LoginScreen onLogin={() => { setLoading(true); void refresh(); }} />;

  const project = state.project;
  const items = state.items || [];
  const sources = state.sources || [];
  const nodes = state.nodes || [];
  const counts = { open: items.filter((item) => item.status !== "concluido" && item.status !== "informativo").length, attention: items.filter((item) => item.attention || item.status === "bloqueado").length, overdue: items.filter(isOverdue).length, done: items.filter((item) => item.status === "concluido").length };

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">GS</div><div><strong>Organizador</strong><small>GRANDE SERTÃO</small></div></div>
      <div className="sidebar-section-label">ESPAÇO DE TRABALHO</div>
      <select className="project-select" value={projectId} onChange={(event) => chooseProject(event.target.value)} aria-label="Selecionar projeto">
        <option value="">Selecionar projeto</option>
        {state.projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      <nav className="nav" aria-label="Navegação principal">
        {views.map((entry) => <button key={entry.id} className={view === entry.id ? "nav-link active" : "nav-link"} onClick={() => setView(entry.id)} disabled={!project}><span className="nav-icon">{entry.icon}</span>{entry.label}{entry.id === "items" && !!counts.open && <em>{counts.open}</em>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="side-help"><strong>Uma fonte. Várias perspectivas.</strong><p>Informações registradas ficam ligadas aos assuntos e podem ser verificadas a qualquer momento.</p></div><div className="account"><span className="avatar">{state.user.email.charAt(0).toUpperCase()}</span><div><strong>{state.user.email.split("@")[0]}</strong><small>{state.user.email}</small></div><button title="Sair" onClick={async () => { await post("/api/auth/logout", {}); setState(null); }}>↗</button></div></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="breadcrumb">Projetos <span>/</span> {project?.name || "Novo projeto"}</div><div className="top-actions"><span className="privacy-pill">● Acesso restrito</span>{project && view !== "sources" && <button className="button primary" onClick={() => { setView("sources"); setComposerFocus((value) => value + 1); }}>＋ Escrever atualização</button>}</div></header>
      {error && <div className="alert error" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
      {notice && <div className="alert success" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {!project ? <CreateProject onCreated={(id) => chooseProject(id)} setBusy={setBusy} busy={busy} setError={setError} /> : <div className="content">
        {view === "overview" && <LivingReportView project={project} items={items} nodes={nodes} topicSummaries={state.topicSummaries || []} syncedAt={syncedAt} onRefresh={() => refresh(projectId)} onOpen={openItem} onCompose={() => { setView("sources"); setComposerFocus((value) => value + 1); }} />}
        {view === "items" && <ItemsView items={items} nodes={nodes} onOpen={openItem} onManual={() => setShowManual(true)} />}
        {view === "sources" && <SourcesView sources={sources} projectId={projectId} onRefresh={after} setError={setError} focusSignal={composerFocus} />}
        {view === "structure" && <StructureView nodes={nodes} projectId={projectId} owner={project.role === "owner"} onRefresh={after} setError={setError} />}
        {view === "people" && <PeopleView members={state.members || []} invitations={state.invitations || []} projectId={projectId} owner={project.role === "owner"} onRefresh={after} setError={setError} />}
        {view === "reports" && <ReportsView items={items} nodes={nodes} project={project} />}
      </div>}
    </main>
    {showManual && project && <ManualModal projectId={projectId} nodes={nodes} close={() => setShowManual(false)} onDone={async (message) => { await after(message); setView("overview"); }} setError={setError} />}
    {selectedItem && project && <ItemDrawer item={selectedItem} nodes={nodes} updates={updates} projectId={projectId} close={() => setSelectedItem(null)} onDone={async () => { await after(); setSelectedItem(null); }} setError={setError} />}
  </div>;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <div className="auth-page"><div className="auth-art"><div className="auth-logo">GS</div><div><span className="eyebrow">INTELIGÊNCIA COMPARTILHADA</span><h1>Informação organizada.<br /><i>Decisões mais claras.</i></h1><p>Um lugar para reunir o que o projeto sabe, acompanhar o que mudou e encontrar o próximo passo.</p></div><small>Organizador Grande Sertão · Acesso restrito</small></div><div className="auth-side"><form className="auth-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await post("/api/auth/login", { email, password }); onLogin(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha no login"); } finally { setBusy(false); } }}><div className="eyebrow">BEM-VINDO DE VOLTA</div><h2>Acesse seu espaço</h2><p>Entre com o e-mail que recebeu acesso ao projeto.</p>{error && <div className="form-error">{error}</div>}<label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="voce@empresa.com" /></label><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="Sua senha" /></label><button className="button primary wide" disabled={busy}>{busy ? "Entrando..." : "Entrar no Organizador →"}</button><small>Recebeu um convite? Abra o link enviado ao seu e-mail.</small></form></div></div>;
}

function InviteScreen({ token }: { token: string }) {
  const [details, setDetails] = useState<{ email: string; projectName: string } | null>(null); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ email: string; projectName: string }>(`/api/invitations/${token}`).then(setDetails).catch((cause) => setError(cause.message)); }, [token]);
  return <div className="invite-page"><div className="brand-mark big">GS</div><div className="auth-card"><div className="eyebrow">CONVITE PARA COLABORAR</div><h1>{details ? `Participe de ${details.projectName}` : "Abrindo convite"}</h1>{error && <div className="form-error">{error}</div>}{details && <form onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { const result = await post<{ projectId: string }>(`/api/invitations/${token}/accept`, { password }); localStorage.setItem("organizador_project", result.projectId); window.location.href = "/"; } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao aceitar convite"); } finally { setBusy(false); } }}><p>Convite para <strong>{details.email}</strong>. Se você já tem conta, informe sua senha; caso contrário, crie uma senha de pelo menos 12 caracteres.</p><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" required /></label><button className="button primary wide" disabled={busy}>{busy ? "Confirmando..." : "Aceitar convite →"}</button></form>}</div></div>;
}

function CreateProject({ onCreated, busy, setBusy, setError }: { onCreated: (id: string) => void; busy: boolean; setBusy: (value: boolean) => void; setError: (value: string) => void }) {
  const [name, setName] = useState("Grande Sertão"); const [description, setDescription] = useState(""); const [withTemplate, setWithTemplate] = useState(true);
  return <div className="content"><div className="empty-project"><div className="eyebrow">COMECE PELO CONTEXTO</div><h1>Crie seu primeiro projeto</h1><p>Organize informações em uma estrutura própria. Você pode começar com o modelo extraído do relatório Grande Sertão e alterá-lo depois.</p><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { const result = await post<{ id: string }>("/api/projects", { name, description, withTemplate }); onCreated(result.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao criar projeto"); } finally { setBusy(false); } }}><label>Nome do projeto<input value={name} onChange={(event) => setName(event.target.value)} required minLength={3} /></label><label>Descrição <span>(opcional)</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Qual é o objetivo deste espaço?" /></label><label className="check-row"><input type="checkbox" checked={withTemplate} onChange={(event) => setWithTemplate(event.target.checked)} /><span>Usar a estrutura inicial do relatório Grande Sertão <small>8 seções, 50 subtítulos e 6 níveis adicionais</small></span></label><button className="button primary" disabled={busy}>{busy ? "Criando..." : "Criar projeto →"}</button></form></div></div>;
}

function Empty({ icon, title, text }: { icon: string; title: string; text: string }) { return <div className="empty"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{text}</p></div>; }

function CategoryQuestion({ item, projectId, options, onRefresh }: { item: Item; projectId: string; options: { id: string; label: string }[]; onRefresh: () => Promise<void> }) {
  const [nodeId, setNodeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  if (!options.length) return null;
  return <form className="category-question" onSubmit={async (event) => {
    event.preventDefault();
    if (!nodeId) return;
    setBusy(true);
    setError("");
    try {
      await post(`/api/projects/${projectId}/items/${item.id}/category`, { nodeId }, "PATCH");
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o tópico"); }
    finally { setBusy(false); }
  }}><label htmlFor={`categoria-${item.id}`}>Em qual tópico esta informação entra?</label><div><select id={`categoria-${item.id}`} value={nodeId} onChange={(event) => setNodeId(event.target.value)} required><option value="">Escolha pela estrutura do projeto</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><button type="submit" className="button secondary" disabled={!nodeId || busy}>Confirmar tópico</button><button type="button" className="button ghost" disabled={busy} onClick={async () => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const result = await post<{ classification: string }>(`/api/projects/${projectId}/items/${item.id}/category/suggest`, {});
      if (result.classification === "automatic") await onRefresh();
      else setInfo("A IA ainda encontrou mais de um tópico possível. Escolha o caminho acima para confirmar.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível analisar o tópico"); }
    finally { setBusy(false); }
  }}>{busy ? "Analisando..." : "Tentar identificar com IA"}</button></div>{info && <small>{info}</small>}{error && <small role="alert">{error}</small>}</form>;
}

function TopicSynthesis({ value, onRetry }: { value?: TopicSummary; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const updating = ["pending", "processing"].includes(value?.analysis_status || "");
  const unavailable = ["failed", "needs_key"].includes(value?.analysis_status || "");
  return <div className="live-topic-synthesis">
    <div className="live-synthesis-heading"><strong>SÍNTESE DO TÓPICO</strong><small>{updating ? "Atualizando síntese..." : value?.generated_at ? `Gerada em ${dateTime(value.generated_at)}` : ""}</small></div>
    {value?.summary ? <p>{value.summary}</p> : <p className="live-synthesis-placeholder">{unavailable ? "Síntese ainda indisponível." : "Analisando o histórico deste tópico..."}</p>}
    {value?.important_change && <div className="live-synthesis-change"><strong>Mudança relevante</strong><p>{value.important_change}</p></div>}
    {unavailable && <div className="live-synthesis-error"><span>Não foi possível atualizar a síntese.</span><button disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await onRetry(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao tentar novamente"); } finally { setBusy(false); } }}>{busy ? "Tentando..." : "Tentar novamente"}</button>{error && <span role="alert">{error}</span>}</div>}
  </div>;
}

function TopicQuickUpdate({ projectId, node, onRefresh }: { projectId: string; node: Node; onRefresh: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  return <form className="live-quick-update" onSubmit={async (event) => {
    event.preventDefault();
    const note = body.trim();
    if (!note || sending) return;
    setSending(true);
    setMessage("");
    setError("");
    try {
      await post(`/api/projects/${projectId}/nodes/${node.id}/updates`, { body: note });
      setBody("");
      setMessage("Informação recebida. Ela aparecerá aqui após a análise.");
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível enviar a atualização"); }
    finally { setSending(false); }
  }}>
    <div className="live-quick-update-row"><textarea aria-label={`Escrever atualização em ${node.title}`} rows={1} maxLength={180000} value={body} onChange={(event) => { setBody(event.target.value); setMessage(""); setError(""); }} placeholder="Escreva uma atualização deste tópico..." /><button type="submit" disabled={!body.trim() || sending}>{sending ? "Enviando..." : "Adicionar"}</button></div>
    {message && <small role="status">{message}</small>}{error && <small className="live-quick-update-error" role="alert">{error}</small>}
  </form>;
}

function LivingReportView({ project, items, nodes, topicSummaries, syncedAt, onRefresh, onOpen, onCompose }: {
  project: Project;
  items: Item[];
  nodes: Node[];
  topicSummaries: TopicSummary[];
  syncedAt: string | null;
  onRefresh: () => Promise<void>;
  onOpen: (item: Item) => Promise<void>;
  onCompose: () => void;
}) {
  const [itemHistory, setItemHistory] = useState<Record<string, HistoryEntry[]>>({});
  const [historyError, setHistoryError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ updates: HistoryEntry[] }>(`/api/projects/${project.id}/history`)
      .then(({ updates }) => {
        if (!active) return;
        const grouped: Record<string, HistoryEntry[]> = {};
        for (const update of updates) (grouped[update.item_id] ||= []).push(update);
        setItemHistory(grouped);
        setHistoryError(false);
      })
      .catch(() => { if (active) setHistoryError(true); });
    return () => { active = false; };
  }, [project.id, items]);

  const activeNodes = nodes.filter((node) => !node.archived);
  const activeIds = new Set(activeNodes.map((node) => node.id));
  const childrenByParent = new Map<string | null, Node[]>();
  for (const node of activeNodes) {
    const parent = node.parent_id && activeIds.has(node.parent_id) ? node.parent_id : null;
    const children = childrenByParent.get(parent) || [];
    children.push(node);
    childrenByParent.set(parent, children);
  }
  for (const children of childrenByParent.values()) children.sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title, "pt-BR"));

  const itemsByNode = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.node_id || !activeIds.has(item.node_id)) continue;
    const group = itemsByNode.get(item.node_id) || [];
    group.push(item);
    itemsByNode.set(item.node_id, group);
  }
  const unclassified = items.filter((item) => !item.node_id || !activeIds.has(item.node_id));
  const options = categoryOptions(nodes);
  const summaryByNode = new Map(topicSummaries.map((summary) => [summary.node_id, summary]));
  const roots = childrenByParent.get(null) || [];
  const countUnder = (id: string): number => (itemsByNode.get(id)?.length || 0) + (childrenByParent.get(id) || []).reduce((total, child) => total + countUnder(child.id), 0);
  const openCount = items.filter((item) => item.status !== "concluido" && item.status !== "informativo").length;
  const attentionCount = items.filter((item) => item.attention || item.status === "bloqueado").length;
  const overdueCount = items.filter(isOverdue).length;
  const emptyLeafCount = activeNodes.filter((node) => !(childrenByParent.get(node.id)?.length) && !(itemsByNode.get(node.id)?.length)).length;

  const topic = (item: Item, needsCategory = false) => {
    const allUpdates = itemHistory[item.id] || [];
    const previous = allUpdates.slice(1);
    const latest = item.latest_update?.trim();
    const summary = item.summary?.trim();
    const details = [
      item.location && `Local: ${item.location}`,
      item.discipline && `Disciplina: ${item.discipline}`,
      item.responsible && `Responsável: ${item.responsible}`,
      item.supplier && `Fornecedor: ${item.supplier}`,
      item.due_date && `Prazo: ${date(item.due_date)}`,
    ].filter(Boolean);
    return <article className="live-topic" key={item.id}>
      <div className="live-topic-heading"><h4>{item.title}</h4><Status item={item} />{Boolean(item.attention) && <span className="live-attention">Ponto de atenção</span>}</div>
      <p className="live-topic-summary">{summary || latest || "Ainda sem resumo do assunto."}</p>
      {details.length > 0 && <p className="live-topic-details">{details.join(" · ")}</p>}
      <div className="live-topic-update"><strong>Última atualização · {dateTime(item.latest_update_at || item.updated_at)}</strong>{latest && latest !== summary && <p>{latest}</p>}{allUpdates[0]?.evidence && allUpdates[0].evidence !== latest && allUpdates[0].evidence !== summary && <blockquote>“{allUpdates[0].evidence}”</blockquote>}<small>{item.source_title ? `Fonte: ${item.source_title}` : "Registro manual"} · {item.update_count || 0} registro(s)</small></div>
      {previous.length > 0 && <div className="live-topic-history"><strong>Histórico de atualizações</strong>{previous.map((update) => <div className="live-history-entry" key={update.id}><p><time>{dateTime(update.created_at)}</time> · {update.summary}</p>{update.evidence && update.evidence !== update.summary && <blockquote>“{update.evidence}”</blockquote>}{update.source_title && <small>Fonte: {update.source_title}</small>}</div>)}</div>}
      {needsCategory && <CategoryQuestion item={item} projectId={project.id} options={options} onRefresh={onRefresh} />}
      <button className="live-topic-action" onClick={() => void onOpen(item)}>Abrir histórico completo e atualizar →</button>
    </article>;
  };

  const renderNode = (node: Node, depth: number, sectionNumber?: number): ReactNode => {
    const direct = itemsByNode.get(node.id) || [];
    const children = childrenByParent.get(node.id) || [];
    const total = countUnder(node.id);
    const title = depth === 0 ? <h2>{node.title}</h2> : depth === 1 ? <h3>{node.title}</h3> : <h4>{node.title}</h4>;
    const synthesis = summaryByNode.get(node.id);
    return <section className={`live-node live-depth-${Math.min(depth, 2)}`} id={`topico-${node.id}`} key={node.id}>
      <div className="live-node-heading">{depth === 0 && <span className="live-section-number">{String(sectionNumber || 1).padStart(2, "0")}</span>}<div>{title}{depth === 0 && <small>{total} assunto(s) com informação</small>}</div></div>
      {total > 0 && <TopicSynthesis value={synthesis} onRetry={async () => { await post(`/api/projects/${project.id}/topics/${node.id}/summary/retry`, {}); await onRefresh(); }} />}
      <TopicQuickUpdate projectId={project.id} node={node} onRefresh={onRefresh} />
      {direct.map((item) => topic(item))}
      {!direct.length && !children.length && <p className="live-empty-topic">Sem informação registrada neste tópico.</p>}
      {children.map((child) => renderNode(child, depth + 1))}
    </section>;
  };

  return <div className="living-report">
    <header className="living-header"><div><div className="eyebrow">ATA VIVA · LEITURA COMPLETA</div><h1>{project.name}</h1><p>{project.description || "Acompanhe todos os tópicos do projeto, as pendências e o que mudou em cada assunto."}</p><small>Sincronizado em {dateTime(syncedAt)} · Atualização automática a cada minuto</small></div><div className="living-header-actions"><button className="button secondary" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }}>{refreshing ? "Atualizando..." : "↻ Atualizar agora"}</button><button className="button secondary" onClick={() => window.print()}>Imprimir / PDF ↗</button></div></header>
    <div className="living-summary"><span><strong>{items.length}</strong> assuntos registrados</span><span><strong>{openCount}</strong> em acompanhamento</span><span className={overdueCount ? "urgent" : ""}><strong>{overdueCount}</strong> atrasados</span><span className={attentionCount ? "urgent" : ""}><strong>{attentionCount}</strong> pontos de atenção</span>{unclassified.length > 0 && <a href="#topico-sem-categoria" className="category-summary"><strong>{unclassified.length}</strong> aguardando tópico</a>}<span><strong>{emptyLeafCount}</strong> tópicos sem registro</span></div>
    {historyError && <p className="report-history-error">O histórico anterior não carregou. Atualize a página para tentar novamente.</p>}
    <div className="living-layout"><nav className="living-contents" aria-label="Sumário do relatório"><strong>NESTA PÁGINA</strong>{roots.map((root, index) => <div className="living-contents-group" key={root.id}><a href={`#topico-${root.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{root.title}<small>{countUnder(root.id)}</small></a>{(childrenByParent.get(root.id) || []).map((child) => <a className="living-contents-child" href={`#topico-${child.id}`} key={child.id}>{child.title}</a>)}</div>)}{unclassified.length > 0 && <a href="#topico-sem-categoria">Sem categoria <small>{unclassified.length}</small></a>}</nav>
      <article className="living-document" aria-label="Relatório completo do projeto">{roots.map((root, index) => renderNode(root, 0, index + 1))}{unclassified.length > 0 && <section className="live-node live-depth-0" id="topico-sem-categoria"><div className="live-node-heading"><div><h2>Aguardando confirmação do tópico</h2><small>{unclassified.length} assunto(s) para organizar</small></div></div>{unclassified.map((item) => topic(item, true))}</section>}{!roots.length && !unclassified.length && <div className="living-start"><h2>O relatório ainda não tem tópicos</h2><p>Crie uma estrutura ou registre a primeira informação para começar.</p><button className="button primary" onClick={onCompose}>Escrever atualização</button></div>}<footer className="living-footer">Fim do relatório · {items.length} assunto(s) · Sincronizado em {dateTime(syncedAt)}</footer></article>
    </div>
  </div>;
}

function ItemsView({ items, nodes, onOpen, onManual }: { items: Item[]; nodes: Node[]; onOpen: (item: Item) => void; onManual: () => void }) {
  const [search, setSearch] = useState(""); const [status, setStatus] = useState(""); const [node, setNode] = useState("");
  const visible = useMemo(() => items.filter((item) => (!status || item.status === status) && (!node || item.node_id === node) && (!search || `${item.title} ${item.summary} ${item.location} ${item.responsible} ${item.supplier}`.toLowerCase().includes(search.toLowerCase()))), [items, search, status, node]);
  return <><div className="page-heading"><div><div className="eyebrow">MAPA DE CONHECIMENTO</div><h1>Assuntos</h1><p>O estado atual de cada assunto, com responsáveis, prazos e fontes.</p></div><button className="button secondary" onClick={onManual}>＋ Registro manual</button></div><div className="filters"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar assuntos, pessoas ou fornecedores..." /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos os estados</option>{Object.entries(statusName).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={node} onChange={(event) => setNode(event.target.value)}><option value="">Todas as categorias</option>{nodes.filter((entry) => !entry.archived).map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></div><div className="panel table-panel"><div className="list-head"><span>ASSUNTO</span><span>ESTADO</span><span>ATUALIZAÇÃO</span></div>{visible.map((item) => <button className="topic-row" key={item.id} onClick={() => onOpen(item)}><div><strong>{item.title}</strong><small>{[item.location, item.discipline, item.responsible].filter(Boolean).join(" · ") || "Sem detalhes adicionais"}</small><span className="topic-latest">{item.latest_update || item.summary || "Sem atualização resumida"}</span><small className="topic-history">{item.update_count || 0} atualização(ões) no histórico · Última em {date(item.latest_update_at || item.updated_at)}</small></div><Status item={item} /><span className="row-date">{date(item.latest_update_at || item.updated_at)}</span></button>)}{!visible.length && <Empty icon="▤" title="Nenhum assunto encontrado" text="Ajuste os filtros ou adicione uma informação ao projeto." />}</div></>;
}

function SourcesView({ sources, projectId, onRefresh, setError, focusSignal }: { sources: Source[]; projectId: string; onRefresh: (message?: string) => Promise<void>; setError: (value: string) => void; focusSignal: number }) {
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pending, setPending] = useState<{ body: string; fileName: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (focusSignal) textRef.current?.focus(); }, [focusSignal]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [sources.length, pending]);

  async function send() {
    const message = body.trim();
    const attachment = file;
    if (sending || (!message && !attachment)) return;
    setSending(true);
    setPending({ body: message, fileName: attachment?.name || "" });
    setBody("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    try {
      let fileData = "";
      if (attachment) {
        if (attachment.size > 5 * 1024 * 1024) throw new Error("O arquivo deve ter até 5 MB");
        fileData = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
          reader.readAsDataURL(attachment);
        });
      }
      const extension = attachment?.name.toLowerCase().split(".").pop() || "";
      const fallbackMime: Record<string, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      const title = message.split(/\r?\n/).find((line) => line.trim())?.slice(0, 120) || attachment?.name || "Nova informação";
      const result = await post<{ status: string; extractedCount: number; error?: string }>(`/api/projects/${projectId}/sources`, {
        title, body: message, fileName: attachment?.name, contentType: attachment?.type || fallbackMime[extension] || "", fileData,
      });
      await onRefresh(result.status === "completed" ? `Informação analisada · ${result.extractedCount} atualização(ões) identificada(s)` : result.status === "processing" ? "Arquivo recebido. A análise dos tópicos está em andamento." : "Informação registrada");
      if (result.status !== "completed" && result.error) setError(result.error);
    } catch (cause) {
      setBody(message);
      setFile(attachment);
      setError(cause instanceof Error ? cause.message : "Falha ao enviar informação");
    } finally {
      setPending(null);
      setSending(false);
    }
  }

  return <div className="conversation-page">
    <div className="page-heading conversation-heading"><div><div className="eyebrow">MEMÓRIA COMPARTILHADA</div><h1>Conversa do projeto</h1><p>Conte o que aconteceu ou anexe um arquivo. A análise organiza as informações na estrutura do projeto.</p></div></div>
    <div className="conversation-feed" aria-label="Informações do projeto">
      {!sources.length && !pending && <div className="conversation-empty"><span>✦</span><h2>Comece com uma mensagem</h2><p>Escreva uma atualização, cole uma transcrição ou anexe um arquivo. Você não precisa escolher categoria nem preencher formulário.</p></div>}
      {sources.slice().reverse().map((source) => {
        const isExpanded = expanded.includes(source.id);
        const longBody = source.body && source.body.length > 1800;
        return <article className="chat-message" key={source.id}>
          <span className="chat-avatar">{source.kind === "file" ? "▧" : "≡"}</span>
          <div className="chat-bubble">
            <div className="chat-meta"><strong className="chat-author">{source.author_email || "Participante"}</strong><time>{date(source.created_at)}</time><span className={`source-state ${source.analysis_status}`}>{source.analysis_status === "completed" ? `Analisado · ${source.topic_count || 0} assunto(s)` : source.analysis_status === "needs_key" ? "IA pendente" : source.analysis_status === "failed" ? "Falha na análise" : source.analysis_status === "manual" ? "Manual" : "Analisando"}</span></div>
            {(!source.body || !source.body.startsWith(source.title)) && <strong className="chat-title">{source.title}</strong>}
            {source.body && <p className="chat-body">{longBody && !isExpanded ? `${source.body.slice(0, 1800)}…` : source.body}</p>}
            {longBody && <button className="chat-link" onClick={() => setExpanded((current) => isExpanded ? current.filter((id) => id !== source.id) : [...current, source.id])}>{isExpanded ? "Mostrar menos" : "Ler mensagem completa"}</button>}
            {source.file_name && <a className="chat-file" href={`/api/projects/${projectId}/sources/${source.id}/file`}>▧ {source.file_name} <span>Baixar ↗</span></a>}
            {source.analysis_error && <div className="source-error">{source.analysis_error}</div>}
            {["failed", "needs_key"].includes(source.analysis_status) && <button className="chat-link" disabled={processing === source.id} onClick={async () => { setProcessing(source.id); try { const result = await post<{ status: string; error?: string }>(`/api/projects/${projectId}/sources/${source.id}/reprocess`, {}); await onRefresh(result.status === "completed" ? "Informação analisada" : "Análise pendente"); if (result.error) setError(result.error); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao reprocessar"); } finally { setProcessing(""); } }}>{processing === source.id ? "Analisando..." : "Tentar analisar novamente"}</button>}
          </div>
        </article>;
      })}
      {pending && <div className="chat-message pending-message"><span className="chat-avatar">≡</span><div className="chat-bubble"><div className="chat-meta"><span className="source-state pending">Analisando...</span></div>{pending.body && <p className="chat-body">{pending.body}</p>}{pending.fileName && <div className="chat-file">▧ {pending.fileName}</div>}</div></div>}
      <div ref={endRef} />
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="chat-input">Nova informação</label>
      <textarea id="chat-input" ref={textRef} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Escreva uma atualização ou cole uma transcrição..." rows={3} disabled={sending} />
      {file && <div className="attachment-chip">▧ {file.name}<button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} aria-label="Remover anexo">×</button></div>}
      <div className="composer-actions"><button className="attach-button" type="button" title="Anexar arquivo" aria-label="Anexar arquivo" disabled={sending} onClick={() => fileRef.current?.click()}>＋</button><input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={(event) => setFile(event.target.files?.[0] || null)} hidden /><span>PDF, DOCX, texto ou imagem · até 5 MB</span><button className="button primary" disabled={sending || (!body.trim() && !file)}>{sending ? "Analisando..." : "Enviar ↗"}</button></div>
    </form>
  </div>;
}

function StructureView({ nodes, projectId, owner, onRefresh, setError }: { nodes: Node[]; projectId: string; owner: boolean; onRefresh: (message?: string) => Promise<void>; setError: (value: string) => void }) {
  const [newTitle, setNewTitle] = useState(""); const [parentId, setParentId] = useState(""); const [expanded, setExpanded] = useState<Set<string>>(new Set(nodes.filter((node) => !node.parent_id).map((node) => node.id)));
  const children = (id: string | null) => nodes.filter((node) => node.parent_id === id && !node.archived).sort((a, b) => a.sort_order - b.sort_order);
  const renderNode = (node: Node, depth: number): ReactNode => <div key={node.id}><div className="structure-row" style={{ paddingLeft: `${18 + depth * 25}px` }}><button className="expand" onClick={() => setExpanded((before) => { const after = new Set(before); after.has(node.id) ? after.delete(node.id) : after.add(node.id); return after; })}>{children(node.id).length ? expanded.has(node.id) ? "⌄" : "›" : "·"}</button><span className={`structure-level level-${depth}`}>{depth === 0 ? "SEÇÃO" : depth === 1 ? "ASSUNTO" : "SUBASSUNTO"}</span><strong>{node.title}</strong>{owner && <div className="structure-actions"><button onClick={async () => { const title = window.prompt("Novo nome da categoria", node.title); if (!title || title === node.title) return; try { await post(`/api/projects/${projectId}/nodes/${node.id}`, { title }, "PATCH"); await onRefresh("Categoria renomeada"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao renomear"); } }}>Renomear</button><button onClick={() => { setParentId(node.id); document.getElementById("new-node-title")?.focus(); }}>＋ Filho</button><button onClick={async () => { if (!window.confirm(`Arquivar “${node.title}”? Os registros existentes serão preservados.`)) return; try { await post(`/api/projects/${projectId}/nodes/${node.id}`, { archived: true }, "PATCH"); await onRefresh("Categoria arquivada"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao arquivar"); } }}>Arquivar</button></div>}</div>{expanded.has(node.id) && children(node.id).map((child) => renderNode(child, depth + 1))}</div>;
  return <><div className="page-heading"><div><div className="eyebrow">ORGANIZAÇÃO FLEXÍVEL</div><h1>Estrutura do projeto</h1><p>Use o modelo como ponto de partida. Categorias novas e renomeadas não apagam o histórico.</p></div><span className="subtle-tag">{nodes.filter((node) => !node.archived).length} categorias ativas</span></div>{owner && <form className="panel add-node" onSubmit={async (event) => { event.preventDefault(); try { await post(`/api/projects/${projectId}/nodes`, { title: newTitle, parentId: parentId || null }); setNewTitle(""); setParentId(""); await onRefresh("Categoria criada"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao criar categoria"); } }}><div><strong>Adicionar categoria</strong><p>Crie uma seção principal ou selecione uma categoria superior.</p></div><input id="new-node-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Nome da categoria" required /><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">Seção principal</option>{nodes.filter((node) => !node.archived).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select><button className="button primary">Adicionar</button></form>}<div className="panel structure-list"><div className="structure-header">ESTRUTURA ATUAL</div>{children(null).map((node) => renderNode(node, 0))}{!nodes.length && <Empty icon="⌘" title="Estrutura em branco" text="Adicione a primeira seção para organizar o projeto." />}</div></>;
}

function PeopleView({ members, invitations, projectId, owner, onRefresh, setError }: { members: Member[]; invitations: Invitation[]; projectId: string; owner: boolean; onRefresh: (message?: string) => Promise<void>; setError: (value: string) => void }) {
  const [email, setEmail] = useState(""); const [busy, setBusy] = useState(false); const [inviteLink, setInviteLink] = useState("");
  return <><div className="page-heading"><div><div className="eyebrow">ACESSO POR PROJETO</div><h1>Pessoas</h1><p>Convide participantes por e-mail e acompanhe quem já tem acesso.</p></div></div>{owner && <form className="panel invite-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setInviteLink(""); try { const result = await post<{ emailed: boolean; inviteUrl?: string }>(`/api/projects/${projectId}/invitations`, { email }); setEmail(""); setInviteLink(result.inviteUrl || ""); await onRefresh(result.emailed ? "Convite enviado por e-mail" : "Convite criado. Configure SMTP para envio automático."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao convidar"); } finally { setBusy(false); } }}><div><h2>Convidar colaborador</h2><p>O convite expira em sete dias e concede acesso somente a este projeto.</p></div><div className="invite-controls"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nome@empresa.com" required /><button className="button primary" disabled={busy}>{busy ? "Enviando..." : "Enviar convite"}</button></div>{inviteLink && <div className="invite-link"><strong>Envio automático indisponível. Compartilhe este link com o destinatário:</strong><code>{inviteLink}</code><button type="button" onClick={() => void navigator.clipboard.writeText(inviteLink)}>Copiar link</button></div>}</form>}<div className="panel members-panel"><div className="panel-head"><div><h2>Participantes</h2><p>{members.length} pessoa(s) com acesso</p></div></div>{members.map((member) => <div className="member-row" key={member.id}><span className="avatar">{member.email.charAt(0).toUpperCase()}</span><div><strong>{member.email}</strong><small>{member.role === "owner" ? "Responsável pelo projeto" : "Colaborador"}</small></div><span className="member-active">Ativo</span></div>)}</div>{!!invitations.filter((entry) => !entry.accepted_at).length && <div className="panel members-panel"><div className="panel-head"><div><h2>Convites pendentes</h2><p>Até a pessoa aceitar o convite</p></div></div>{invitations.filter((entry) => !entry.accepted_at).map((entry) => <div className="member-row" key={entry.id}><span className="avatar muted">✉</span><div><strong>{entry.email}</strong><small>Expira em {date(entry.expires_at)}</small></div><span className="source-state pending">Pendente</span></div>)}</div>}</>;
}

function ReportsView({ items, nodes, project }: { items: Item[]; nodes: Node[]; project: Project }) {
  const [kind, setKind] = useState("general"); const [filter, setFilter] = useState("");
  const [itemHistory, setItemHistory] = useState<Record<string, HistoryEntry[]>>({});
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    let active = true;
    setItemHistory({});
    setHistoryError(false);
    api<{ updates: HistoryEntry[] }>(`/api/projects/${project.id}/history`)
      .then(({ updates }) => {
        if (!active) return;
        const grouped: Record<string, HistoryEntry[]> = {};
        for (const update of updates) (grouped[update.item_id] ||= []).push(update);
        setItemHistory(grouped);
      })
      .catch(() => { if (active) setHistoryError(true); });
    return () => { active = false; };
  }, [project.id]);
  const list = filter ? items.filter((item) => item.node_id === filter) : items;
  const byResponsible = list.reduce<Record<string, Item[]>>((groups, item) => { const key = item.responsible || "Não atribuído"; (groups[key] ||= []).push(item); return groups; }, {});
  const byPartner = list.reduce<Record<string, Item[]>>((groups, item) => { const key = item.supplier || "Não identificado"; (groups[key] ||= []).push(item); return groups; }, {});
  return <><div className="page-heading"><div><div className="eyebrow">SAÍDAS DO PROJETO</div><h1>Relatórios e matrizes</h1><p>Visões geradas a partir dos assuntos e suas fontes registradas.</p></div><button className="button secondary" onClick={() => window.print()}>Imprimir / salvar PDF ↗</button></div><div className="report-controls"><label>Tipo de relatório<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="general">Acompanhamento geral</option><option value="responsibility">Matriz de responsabilidades</option><option value="communication">Matriz de comunicação</option><option value="subject">Relatório por assunto</option></select></label><label>Categoria<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">Todas as categorias</option>{nodes.filter((node) => !node.archived).map((node) => <option value={node.id} key={node.id}>{node.title}</option>)}</select></label></div><article className="panel report"><div className="report-title"><span>RELATÓRIO DO PROJETO</span><h2>{project.name}</h2><p>Gerado em {new Date().toLocaleString("pt-BR")} · {list.length} assunto(s)</p></div>{historyError && <p className="report-history-error">Não foi possível carregar o histórico anterior; tente atualizar a página.</p>}{kind === "general" && <><div className="report-summary"><span><strong>{list.filter((item) => item.status !== "concluido").length}</strong> em acompanhamento</span><span><strong>{list.filter(isOverdue).length}</strong> atrasados</span><span><strong>{list.filter((item) => item.attention).length}</strong> pontos de atenção</span></div>{list.map((item) => <div className="report-entry" key={item.id}><div><h3>{item.title}</h3><Status item={item} /></div><p>{item.summary || "Sem resumo"}</p><small>{[item.location, item.discipline, item.supplier && `Fornecedor: ${item.supplier}`, item.responsible && `Responsável: ${item.responsible}`, item.due_date && `Prazo: ${date(item.due_date)}`].filter(Boolean).join(" · ")}</small><small>Última atualização em {date(item.latest_update_at || item.updated_at)}: {item.latest_update || item.summary || "Sem resumo"}</small><small>{item.update_count || 0} registro(s) no histórico · Fonte mais recente: {item.source_title || "Registro manual"}</small>{(itemHistory[item.id] || []).length > 1 && <div className="report-history"><strong>Atualizações anteriores</strong>{itemHistory[item.id].slice(1, 3).map((update, index) => <p key={`${update.created_at}-${index}`}><time>{date(update.created_at)}</time> · {update.summary}{update.source_title && <span> · Fonte: {update.source_title}</span>}</p>)}</div>}</div>)}</>}{kind === "responsibility" && Object.entries(byResponsible).map(([responsible, group]) => <div className="report-group" key={responsible}><h3>{responsible}</h3><ReportTable items={group || []} /></div>)}{kind === "communication" && <><p className="report-note">Esta matriz reúne interlocutores citados nas fontes. Canal e frequência de contato devem ser definidos pelo grupo.</p>{Object.entries(byPartner).map(([partner, group]) => <div className="report-group" key={partner}><h3>{partner}</h3><table><thead><tr><th>Assunto</th><th>Responsável</th><th>Situação</th><th>Última atualização</th></tr></thead><tbody>{(group || []).map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.responsible || "A definir"}</td><td>{statusName[item.status]}</td><td>{date(item.updated_at)}</td></tr>)}</tbody></table></div>)}</>}{kind === "subject" && <ReportTable items={list} />}{!list.length && <Empty icon="▣" title="Sem dados para este relatório" text="Registre informações ou altere o filtro para gerar a visão." />}</article></>;
}

function ReportTable({ items }: { items: Item[] }) { return <table><thead><tr><th>Assunto</th><th>Estado</th><th>Prazo</th><th>Última atualização</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.title}</td><td>{statusName[item.status]}</td><td>{date(item.due_date)}</td><td>{date(item.latest_update_at || item.updated_at)} · {item.latest_update || item.summary || "Sem resumo"}</td></tr>)}</tbody></table>; }

function ManualModal({ projectId, nodes, close, onDone, setError }: { projectId: string; nodes: Node[]; close: () => void; onDone: (message?: string) => Promise<void>; setError: (value: string) => void }) {
  const [form, setForm] = useState({ title: "", summary: "", nodeId: "", location: "", discipline: "", supplier: "", responsible: "", status: "pendente", dueDate: "", attention: false });
  const [saving, setSaving] = useState(false);
  const change = (key: keyof typeof form, value: string | boolean) => setForm((before) => ({ ...before, [key]: value }));
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Registro manual"><button className="close" onClick={close}>×</button><div className="eyebrow">REGISTRO DIRETO</div><h2>Novo assunto manual</h2><p>Se deixar o tópico em automático, a IA tentará colocá-lo na estrutura do projeto.</p><form onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { const result = await post<{ classification: string }>(`/api/projects/${projectId}/items`, form); close(); await onDone(result.classification === "needs_confirmation" ? "Assunto registrado. Confirme o tópico no relatório vivo." : "Assunto registrado no tópico"); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao registrar assunto"); } finally { setSaving(false); } }}><label>Assunto<input required value={form.title} onChange={(event) => change("title", event.target.value)} /></label><label>Resumo<textarea required rows={3} value={form.summary} onChange={(event) => change("summary", event.target.value)} /></label><div className="form-grid"><label>Tópico<select value={form.nodeId} onChange={(event) => change("nodeId", event.target.value)}><option value="">Classificar automaticamente</option>{categoryOptions(nodes).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><label>Estado<select value={form.status} onChange={(event) => change("status", event.target.value)}>{Object.entries(statusName).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label>Local<input value={form.location} onChange={(event) => change("location", event.target.value)} /></label><label>Disciplina<input value={form.discipline} onChange={(event) => change("discipline", event.target.value)} /></label><label>Fornecedor<input value={form.supplier} onChange={(event) => change("supplier", event.target.value)} /></label><label>Responsável<input value={form.responsible} onChange={(event) => change("responsible", event.target.value)} /></label><label>Prazo<input type="date" value={form.dueDate} onChange={(event) => change("dueDate", event.target.value)} /></label></div><label className="check-row"><input type="checkbox" checked={form.attention} onChange={(event) => change("attention", event.target.checked)} />Marcar como ponto de atenção</label><div className="modal-actions"><button type="button" className="button ghost" onClick={close}>Cancelar</button><button className="button primary" disabled={saving}>{saving ? "Classificando..." : "Salvar assunto"}</button></div></form></div></div>;
}

function ItemDrawer({ item, nodes, updates, projectId, close, onDone, setError }: { item: Item; nodes: Node[]; updates: Update[]; projectId: string; close: () => void; onDone: () => Promise<void>; setError: (value: string) => void }) {
  const [status, setStatus] = useState(item.status); const [nodeId, setNodeId] = useState(nodes.some((node) => node.id === item.node_id && !node.archived) ? item.node_id || "" : ""); const [responsible, setResponsible] = useState(item.responsible); const [supplier, setSupplier] = useState(item.supplier); const [dueDate, setDueDate] = useState(item.due_date); const [note, setNote] = useState(""); const [attention, setAttention] = useState(Boolean(item.attention)); const [busy, setBusy] = useState(false);
  return <div className="drawer-backdrop" onMouseDown={close}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={item.title}><button className="close" onClick={close}>×</button><div className="eyebrow">ASSUNTO DO PROJETO</div><h2>{item.title}</h2><Status item={item} /><p className="drawer-summary">{item.summary}</p><section className="latest-update-card"><small>ÚLTIMA ATUALIZAÇÃO · {date(item.latest_update_at || item.updated_at)}</small><p>{item.latest_update || item.summary || "Sem atualização resumida"}</p><span>{item.update_count || 0} registro(s) no histórico{item.latest_update_author ? ` · ${item.latest_update_author}` : ""}</span></section><div className="detail-grid"><div><small>LOCAL</small><strong>{item.location || "Não identificado"}</strong></div><div><small>DISCIPLINA</small><strong>{item.discipline || "Não identificada"}</strong></div><div><small>FONTE MAIS RECENTE</small><strong>{item.source_title || "Registro manual"}</strong></div><div><small>ATUALIZAÇÃO</small><strong>{date(item.latest_update_at || item.updated_at)}</strong></div></div><form className="drawer-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await post(`/api/projects/${projectId}/items/${item.id}`, { nodeId, status, responsible, supplier, dueDate, note, attention }, "PATCH"); await onDone(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao atualizar"); } finally { setBusy(false); } }}><h3>Atualizar acompanhamento</h3><div className="form-grid"><label>Tópico<select value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">Aguardando confirmação</option>{categoryOptions(nodes).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value)}>{Object.entries(statusName).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label>Prazo<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label>Responsável<input value={responsible} onChange={(event) => setResponsible(event.target.value)} /></label><label>Fornecedor<input value={supplier} onChange={(event) => setSupplier(event.target.value)} /></label></div><label>Nota da atualização<textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="O que mudou?" /></label><label className="check-row"><input type="checkbox" checked={attention} onChange={(event) => setAttention(event.target.checked)} />Ponto de atenção</label><button className="button primary" disabled={busy}>{busy ? "Salvando..." : "Salvar atualização"}</button></form><section className="timeline"><h3>Histórico e evidências</h3>{updates.map((update) => <div className="timeline-entry" key={update.id}><span className="timeline-dot" /><small>{date(update.created_at)} · {update.author_email || "Análise automática"}</small><p>{update.summary}</p>{update.evidence && <blockquote>“{update.evidence}”</blockquote>}{update.source_title && <small>Fonte: {update.source_title}</small>}</div>)}{!updates.length && <p className="muted-text">Nenhuma atualização registrada.</p>}</section></aside></div>;
}
