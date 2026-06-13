import { describe, expect, it } from 'vitest'
import { routeDeterministicAction, extractGithubRepoUrl, listDeterministicActions } from '../server/deterministicActionRouter.js'

describe('deterministic action router', () => {
  it('normalizes GitHub repo URLs for download commands', () => {
    expect(extractGithubRepoUrl('скачай https://github.com/robesthud/browserAI')).toBe('https://github.com/robesthud/browserAI.git')
    expect(extractGithubRepoUrl('clone https://github.com/robesthud/browserAI.git/')).toBe('https://github.com/robesthud/browserAI.git')
  })

  it('routes repo download without involving the LLM', () => {
    const action = routeDeterministicAction([{ role: 'user', content: 'https://github.com/robesthud/browserAI скачай файлы' }])
    expect(action?.id).toBe('repo_download')
    expect(action?.tool).toBe('git_clone')
    expect(action?.args.url).toBe('https://github.com/robesthud/browserAI.git')
  })

  it('routes zip/archive requests without involving the LLM', () => {
    const action = routeDeterministicAction([{ role: 'user', content: 'запакуй файлы в zip архив' }])
    expect(action?.id).toBe('archive_zip')
    expect(action?.tool).toBe('zip_files')
    expect(action?.args.output_path).toBe('workspace.zip')
  })

  it('does not hijack complex code tasks', () => {
    expect(routeDeterministicAction([{ role: 'user', content: 'проанализируй проект и найди баги' }])).toBeNull()
  })

  it('exposes declarative action metadata', () => {
    expect(listDeterministicActions().map(a => a.id)).toEqual(['repo_download', 'archive_zip'])
  })
})
