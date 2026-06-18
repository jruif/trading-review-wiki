import { useEffect, useState } from "react"
import { FolderOpen, Plus, Clock, X, TrendingUp, BookOpen, Lightbulb } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getRecentProjects, removeFromRecentProjects } from "@/lib/project-store"
import type { WikiProject } from "@/types/wiki"
import { useTranslation } from "react-i18next"

interface WelcomeScreenProps {
  onCreateProject: () => void
  onOpenProject: () => void
  onSelectProject: (project: WikiProject) => void
  openingProjectPath?: string | null
}

export function WelcomeScreen({
  onCreateProject,
  onOpenProject,
  onSelectProject,
  openingProjectPath = null,
}: WelcomeScreenProps) {
  const { t } = useTranslation()
  const [recentProjects, setRecentProjects] = useState<WikiProject[]>([])

  useEffect(() => {
    getRecentProjects().then(setRecentProjects).catch(() => {})
  }, [])

  async function handleRemoveRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    await removeFromRecentProjects(path)
    const updated = await getRecentProjects()
    setRecentProjects(updated)
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 px-4 max-w-2xl">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <TrendingUp className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-3xl font-bold">{t("app.title")}</h1>
          <p className="mt-2 text-muted-foreground">
            {t("app.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full">
          <div className="rounded-lg border bg-card p-4 text-center">
            <BookOpen className="mx-auto mb-2 h-5 w-5 text-bullish" />
            <div className="text-sm font-medium">记录交易</div>
            <div className="text-xs text-muted-foreground">日复盘、交割单、截图</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <Lightbulb className="mx-auto mb-2 h-5 w-5 text-primary" />
            <div className="text-sm font-medium">提炼模式</div>
            <div className="text-xs text-muted-foreground">策略、个股、错误档案</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <TrendingUp className="mx-auto mb-2 h-5 w-5 text-bearish" />
            <div className="text-sm font-medium">复利进化</div>
            <div className="text-xs text-muted-foreground">Lint 深度复盘，理解越来越深</div>
          </div>
        </div>

        <div className="flex gap-3">
          <Button onClick={onCreateProject}>
            <Plus className="mr-2 h-4 w-4" />
            {t("welcome.newProject")}
          </Button>
          <Button variant="outline" onClick={onOpenProject}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {t("welcome.openProject")}
          </Button>
        </div>

        {recentProjects.length > 0 && (
          <div className="w-full max-w-md">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {t("welcome.recentProjects")}
            </div>
            <div className="rounded-lg border">
              {recentProjects.map((proj) => {
                const isOpening = openingProjectPath === proj.path
                return (
                <button
                  key={proj.path}
                  onClick={() => onSelectProject(proj)}
                  disabled={!!openingProjectPath}
                  className="group flex w-full items-center justify-between border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent disabled:cursor-wait disabled:opacity-70"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{proj.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {isOpening ? "正在打开…" : proj.path}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleRemoveRecent(e, proj.path)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRemoveRecent(e as unknown as React.MouseEvent, proj.path)
                    }}
                    className="ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
