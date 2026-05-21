type DeploymentEnv = {
  [key: string]: string | undefined;
  NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT?: string;
};

export function isGeneratorDeployment(env: DeploymentEnv = process.env): boolean {
  return env.NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT?.trim() === 'generator';
}

export function isSystemDeployment(env: DeploymentEnv = process.env): boolean {
  return !isGeneratorDeployment(env);
}
