/**
 * 内置凭据动作设置面板。
 *
 * 档案的密码默认只给人看，模型读不到。内置动作让模型在不看到密码的前提下
 * 完成最常见的两件事：
 *   · `vault_ssh`  —— 用记录里的 SSH 密码 / 私钥登录**记录自己的主机**执行命令；
 *   · `vault_http` —— 用记录里的 API Key / Web Key 请求**记录自己的 URL**。
 *
 * 这两个动作默认开启，不需要用户安装 sshpass、不需要配置程序白名单；目标
 * 主机 / 域名只能来自档案记录本身，模型无法把它们改到别处。这里只留一个
 * 总开关，让不想用的人可以一键关掉；审计列在下方，方便看「它到底用过我的
 * 密码没有」。
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { formatVaultStamp, listVaultAudit, setVaultConfig } from './api.js'
import type { VaultAuditEntry } from './api.js'
import type { VaultConfig, VaultRecord } from '../../../triad/vault/types.js'
import { css } from './styles.js'
import { ShieldIcon } from './icons.js'

export interface VaultBrokerPanelProps {
  /** 当前配置（父级 /list 拿到的公开视图）。 */
  config: Partial<VaultConfig>
  /** 记录清单（审计里把 recordId 显示成标题）。 */
  records: VaultRecord[]
  /** 保存成功后把新配置交回父级。 */
  onSaved: (config: Partial<VaultConfig>) => void
  onError: (message: string) => void
  onFlash: (message: string) => void
}

export function VaultBrokerPanel({ config, records, onSaved, onError, onFlash }: VaultBrokerPanelProps): JSX.Element {
  const [enabled, setEnabled] = useState<boolean>(config.credentialBuiltins !== false)
  const [saving, setSaving] = useState<boolean>(false)
  const [audit, setAudit] = useState<VaultAuditEntry[]>([])

  const loadAudit = useCallback(async (): Promise<void> => {
    try {
      const entries = await listVaultAudit(60)
      setAudit(entries.filter((entry) => entry.action === 'exec').slice(0, 10))
    } catch {
      // 审计读不到不影响设置；页面下方会显示「还没有记录」。
      setAudit([])
    }
  }, [])

  useEffect(() => { void loadAudit() }, [loadAudit])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await setVaultConfig({ credentialBuiltins: enabled })
      onSaved(next)
      onFlash('凭据代用设置已保存')
      void loadAudit()
    } catch (reason) {
      onError('保存失败：' + (reason instanceof Error ? reason.message : String(reason)))
    } finally {
      setSaving(false)
    }
  }

  const titleOf = (recordId: string): string => {
    const record = records.find((item) => item.id === recordId)
    return record?.title ?? recordId
  }

  return (
    <div className={css.backup} data-role="broker">
      {/* ── 内置动作总开关 ── */}
      <div className={css.backupSection} data-role="section" data-section="builtins">
        <div className={css.backupLabel} data-role="section-head">
          <ShieldIcon size={14} />
          内置凭据动作
        </div>
        <div className={css.backupHint}>
          开启后 AI 可以直接用 `vault_ssh` 登录档案记录里的服务器执行命令，或用 `vault_http`
          调用记录里存了 API Key 的服务。目标主机 / 域名只能来自记录本身；密码不会返回给 AI，
          也不需要你安装 sshpass 或配置任何程序。
        </div>
        <label className={css.backupHint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => { setEnabled(event.target.checked) }}
          />
          允许内置 SSH / HTTP 动作（默认开启）
        </label>
        <div className={css.backupRow} data-role="actions">
          <button type="button" className={css.btn + ' ' + css.btnPri} disabled={saving} onClick={() => { void save() }}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>

      {/* ── 最近代用记录 ── */}
      <div className={css.backupSection} data-role="section" data-section="audit">
        <div className={css.backupLabel} data-role="section-head">
          最近的凭据代用
        </div>
        {audit.length === 0
          ? <div className={css.backupHint}>还没有代用记录。</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {audit.map((entry) => (
                <div key={entry.at + entry.recordId + (entry.program ?? '')} className={css.backupFingerprint} style={{ fontWeight: 400 }}>
                  {formatVaultStamp(entry.at)} · {titleOf(entry.recordId)} · {entry.fieldKey} → {entry.program ?? '（未知）'}
                  {' · '}{entry.exitCode === 0 ? '成功' : '退出码 ' + String(entry.exitCode ?? '?')}
                  {entry.purpose !== undefined && entry.purpose !== '' ? ' · ' + entry.purpose : ''}
                </div>
              ))}
            </div>
          )}
        <div className={css.backupHint}>
          每次代用都会写进本机 audit.jsonl；这里不显示密码，宿主也不会把密码写进日志。
        </div>
      </div>
    </div>
  )
}
