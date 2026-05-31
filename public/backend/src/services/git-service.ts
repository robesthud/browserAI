// ============================================
// AI CODE STUDIO - GIT SERVICE
// Decoupled simple-git business logic
// ============================================

import simpleGit from 'simple-git';

export class GitService {
  private static getGit(projectPath: string): any {
    const sg = simpleGit as any;
    if (typeof sg === 'function') return sg(projectPath);
    if (sg.simpleGit && typeof sg.simpleGit === 'function') return sg.simpleGit(projectPath);
    if (sg.default && typeof sg.default === 'function') return sg.default(projectPath);
    return sg;
  }

  static async clone(projectPath: string, url: string, branch?: string) {
    const git = this.getGit(projectPath);
    return git.clone(url, '.', branch ? ['--branch', branch] : []);
  }

  static async commit(projectPath: string, message: string) {
    const git = this.getGit(projectPath);
    await git.add('.');
    return git.commit(message);
  }

  static async push(projectPath: string, branch: string) {
    const git = this.getGit(projectPath);
    return git.push('origin', branch);
  }

  static async pull(projectPath: string, branch: string) {
    const git = this.getGit(projectPath);
    return git.pull('origin', branch);
  }

  static async getLog(projectPath: string, limit = 50) {
    const git = this.getGit(projectPath);
    return git.log({ maxCount: limit });
  }

  static async getBranches(projectPath: string) {
    const git = this.getGit(projectPath);
    return git.branch();
  }

  static async checkout(projectPath: string, branch: string, create = false) {
    const git = this.getGit(projectPath);
    if (create) {
      await git.checkoutBranch(branch, 'HEAD');
    } else {
      await git.checkout(branch);
    }
  }
} 
