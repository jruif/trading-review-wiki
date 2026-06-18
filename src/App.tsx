import { useState, useEffect, useRef } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import { useResearchStore } from "@/stores/research-store"
import { openProject } from "@/commands/fs"
import { syncClipServerProjects } from "@/lib/clip-sync"
import { getLastProject, saveLastProject, loadLlmConfig, loadLanguage, loadSearchApiConfig, loadEmbeddingConfig, loadAppTheme, loadPgConfig } from "@/lib/project-store"
import { syncStockCodes } from "@/commands/stock-codes"
import { loadReviewItems, loadChatHistory } from "@/lib/persist"
import { setupAutoSave, teardownAutoSave } from "@/lib/auto-save"
import { startClipWatcher, stopClipWatcher } from "@/lib/clip-watcher"
import { AppLayout } from "@/components/layout/app-layout"
import { WelcomeScreen } from "@/components/project/welcome-screen"
import { CreateProjectDialog } from "@/components/project/create-project-dialog"
import type { WikiProject } from "@/types/wiki"

function App() {
  const project = useWikiStore((s) => s.project)
  const setProject = useWikiStore((s) => s.setProject)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setChatExpanded = useWikiStore((s) => s.setChatExpanded)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [loading, setLoading] = useState(true)
  const [openingProjectPath, setOpeningProjectPath] = useState<string | null>(null)
  const projectOpenInFlight = useRef(false)
  const skipAutoOpenRef = useRef(false)

  // Set up auto-save and clip watcher once on mount
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
    return () => {
      teardownAutoSave()
      stopClipWatcher()
    }
  }, [])

  // Apply initial theme (dark class handled by setAppTheme in store)
  useEffect(() => {
    const appTheme = useWikiStore.getState().appTheme
    if (appTheme !== "light") {
      document.documentElement.classList.add("dark")
    }
  }, [])

  // Load saved settings, then show UI; open last project in background
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const savedConfig = await loadLlmConfig()
        if (!cancelled && savedConfig) {
          useWikiStore.getState().setLlmConfig(savedConfig)
        }
        const savedSearchConfig = await loadSearchApiConfig()
        if (!cancelled && savedSearchConfig) {
          useWikiStore.getState().setSearchApiConfig(savedSearchConfig)
        }
        const savedEmbeddingConfig = await loadEmbeddingConfig()
        if (!cancelled && savedEmbeddingConfig) {
          useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
        }
        const savedPgConfig = await loadPgConfig()
        if (!cancelled && savedPgConfig) {
          useWikiStore.getState().setPgConfig(savedPgConfig)
        }
        const savedLang = await loadLanguage()
        if (!cancelled && savedLang) {
          await i18n.changeLanguage(savedLang)
        }
        const savedTheme = await loadAppTheme()
        if (!cancelled && savedTheme) {
          useWikiStore.getState().setAppTheme(savedTheme)
        }
      } catch (err) {
        console.warn("[App] Init error:", err)
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }

      if (cancelled || skipAutoOpenRef.current) return

      const lastProject = await getLastProject()
      if (!lastProject || cancelled || skipAutoOpenRef.current) return
      if (useWikiStore.getState().project) return

      if (projectOpenInFlight.current) return
      projectOpenInFlight.current = true
      try {
        const proj = await openProject(lastProject.path)
        if (!cancelled && !skipAutoOpenRef.current) {
          transitionToProject(proj)
          loadProjectBackground(proj)
        }
      } catch (err) {
        console.warn("[App] Failed to open last project:", err)
      } finally {
        projectOpenInFlight.current = false
      }
    }
    init()
    return () => {
      cancelled = true
    }
  }, [])

  async function loadProjectSideData(proj: WikiProject) {
    const results = await Promise.allSettled([
      loadReviewItems(proj.path),
      loadChatHistory(proj.path),
    ])

    const reviewResult = results[0]
    if (reviewResult.status === "fulfilled") {
      useReviewStore.getState().setItems(reviewResult.value)
    } else {
      console.warn("[App] Failed to load review items:", reviewResult.reason)
    }

    const chatResult = results[1]
    if (chatResult.status === "fulfilled") {
      const savedChat = chatResult.value
      useChatStore.getState().setConversations(savedChat.conversations)
      useChatStore.getState().setMessages(savedChat.messages)
      const sorted = [...savedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      if (sorted[0]) {
        useChatStore.getState().setActiveConversation(sorted[0].id)
      }
    } else {
      console.warn("[App] Failed to load chat history:", chatResult.reason)
    }
  }

  function transitionToProject(proj: WikiProject) {
    // Clear project-scoped stores so we don't leak data from the previous project
    useReviewStore.getState().setItems([])
    useChatStore.getState().resetProjectState()
    useResearchStore.getState().clearTasks()
    useResearchStore.getState().setPanelOpen(false)

    setProject(proj)
    setFileTree([])
    setSelectedFile(null)
    setFileContent("")
    setActiveView("wiki")
    setChatExpanded(false)
  }

  function loadProjectBackground(proj: WikiProject) {
    void (async () => {
      try {
        await saveLastProject(proj)
      } catch (err) {
        console.warn("[App] Failed to save last project:", err)
      }

      // Restore ingest queue (resume interrupted tasks)
      import("@/lib/ingest-queue").then(({ restoreQueue }) => {
        restoreQueue(proj.path).catch((err) =>
          console.error("Failed to restore ingest queue:", err)
        )
      })

      // Background-sync stock codes from PG (24h cache; no-op if config empty)
      const pgConfig = useWikiStore.getState().pgConfig
      if (pgConfig.host && pgConfig.user && pgConfig.password && pgConfig.database && pgConfig.port) {
        syncStockCodes(proj.path, pgConfig, false).catch((err) =>
          console.warn("[App] Stock code sync failed:", err)
        )
      }

      // Notify local clip server (retries until port 19827 is listening)
      syncClipServerProjects(proj).catch((err) =>
        console.warn("[App] Failed to sync clip server projects:", err)
      )

      // File tree is loaded by AppLayout; review/chat load in parallel without blocking UI
      await loadProjectSideData(proj)
    })()
  }

  function handleProjectOpened(proj: WikiProject) {
    transitionToProject(proj)
    loadProjectBackground(proj)
  }

  async function openProjectExclusive(path: string): Promise<WikiProject> {
    skipAutoOpenRef.current = true
    while (projectOpenInFlight.current) {
      await new Promise((r) => setTimeout(r, 50))
    }
    projectOpenInFlight.current = true
    try {
      return await openProject(path)
    } finally {
      projectOpenInFlight.current = false
    }
  }

  async function handleSelectRecent(proj: WikiProject) {
    setOpeningProjectPath(proj.path)
    try {
      const validated = await openProjectExclusive(proj.path)
      transitionToProject(validated)
      loadProjectBackground(validated)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    } finally {
      setOpeningProjectPath(null)
    }
  }

  async function handleOpenProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Wiki Project",
    })
    if (!selected) return
    setOpeningProjectPath(selected)
    try {
      const proj = await openProjectExclusive(selected)
      transitionToProject(proj)
      loadProjectBackground(proj)
    } catch (err) {
      window.alert(`Failed to open project: ${err}`)
    } finally {
      setOpeningProjectPath(null)
    }
  }

  function handleSwitchProject() {
    setProject(null)
    setFileTree([])
    setSelectedFile(null)
    setFileContent("")
    setActiveView("wiki")
    setChatExpanded(false)
    useReviewStore.getState().setItems([])
    useChatStore.getState().resetProjectState()
    useResearchStore.getState().clearTasks()
    useResearchStore.getState().setPanelOpen(false)
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!project) {
    return (
      <>
        <WelcomeScreen
          onCreateProject={() => setShowCreateDialog(true)}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectRecent}
          openingProjectPath={openingProjectPath}
        />
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleProjectOpened}
        />
      </>
    )
  }

  return (
    <>
      <AppLayout onSwitchProject={handleSwitchProject} />
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleProjectOpened}
      />
    </>
  )
}

export default App
