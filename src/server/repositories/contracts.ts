declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' };

export type PostgreSQLRepositoryAuthority = {
  readonly storage: 'postgresql';
  readonly tenantId: TenantId;
  readonly tenantStatus: 'ACTIVE';
};

export type LegacySheetsRepositoryAuthority = {
  readonly storage: 'sheets';
  readonly legacy: true;
};

export type RepositoryAuthority =
  | PostgreSQLRepositoryAuthority
  | LegacySheetsRepositoryAuthority;

export type PostgreSQLRepositoryContext<TAdapter> = PostgreSQLRepositoryAuthority & {
  readonly adapter: TAdapter;
};

export type LegacySheetsRepositoryContext<TAdapter> = LegacySheetsRepositoryAuthority & {
  readonly adapter: TAdapter;
};

export type ResolvedRepository<TPostgreSQLAdapter, TSheetsAdapter> =
  | PostgreSQLRepositoryContext<TPostgreSQLAdapter>
  | LegacySheetsRepositoryContext<TSheetsAdapter>;
