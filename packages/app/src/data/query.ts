import {
  keepPreviousData,
  skipToken,
  useQueries,
  useQuery,
  type QueryKey,
  type QueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

type QueryFnOption<TQueryFnData, TError, TData, TQueryKey extends QueryKey> = NonNullable<
  UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>["queryFn"]
>;

type ReplicaQueryInput<TQueryFnData, TError, TData, TQueryKey extends QueryKey> = Omit<
  UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  | "gcTime"
  | "initialData"
  | "refetchOnMount"
  | "refetchOnReconnect"
  | "refetchOnWindowFocus"
  | "staleTime"
> & {
  pushEvent: string;
};

type FetchQueryInput<TQueryFnData, TError, TData, TQueryKey extends QueryKey> = Omit<
  UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  "initialData" | "placeholderData" | "queryFn" | "staleTime"
> & {
  dataShape: "list" | "value";
  queryFn: QueryFnOption<TQueryFnData, TError, TData, TQueryKey>;
} & (
    | { staleTimeMs: number; immutableWhen?: never }
    | { staleTimeMs?: never; immutableWhen: (data: TQueryFnData) => boolean }
  );

export function useReplicaQuery<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(input: ReplicaQueryInput<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  return useQuery(replicaQueryOptions(input));
}

export function useFetchQuery<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  input: FetchQueryInput<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClient,
): UseQueryResult<TData, TError> {
  return useQuery(fetchQueryOptions(input), queryClient);
}

export function useFetchQueries<TData>(
  inputs: FetchQueryInput<TData, Error, TData, QueryKey>[],
): UseQueryResult<TData, Error>[];
/**
 * With `combine`, the result keeps its identity until a query's data changes, so memos that
 * depend on it hold across renders. Pass a stable function, such as one defined at module scope.
 */
export function useFetchQueries<TData, TCombined>(
  inputs: FetchQueryInput<TData, Error, TData, QueryKey>[],
  combine: (results: UseQueryResult<TData, Error>[]) => TCombined,
): TCombined;
export function useFetchQueries<TData, TCombined>(
  inputs: FetchQueryInput<TData, Error, TData, QueryKey>[],
  combine?: (results: UseQueryResult<TData, Error>[]) => TCombined,
) {
  return useQueries({
    queries: inputs.map((input) => fetchQueryOptions(input)),
    ...(combine ? { combine } : {}),
  });
}

function replicaQueryOptions<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  input: ReplicaQueryInput<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> {
  const { pushEvent, meta, ...options } = input;
  return {
    ...options,
    gcTime: Infinity,
    meta: {
      ...meta,
      serverDataPolicy: {
        class: "replica",
        pushEvent,
      },
    },
    queryFn: options.queryFn ?? skipToken,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  };
}

export function fetchQueryOptions<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  input: FetchQueryInput<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> {
  if (!input.immutableWhen && !Number.isFinite(input.staleTimeMs)) {
    throw new Error("Fetch queries must declare a finite staleTimeMs.");
  }

  const { dataShape, meta, staleTimeMs, immutableWhen, ...options } = input;
  return {
    ...options,
    ...(dataShape === "list" ? { placeholderData: keepPreviousData } : {}),
    meta: {
      ...meta,
      serverDataPolicy: {
        class: "fetch",
        dataShape,
      },
    },
    refetchOnMount: options.refetchOnMount ?? (immutableWhen ? true : "always"),
    staleTime: immutableWhen
      ? (query) =>
          query.state.data !== undefined && immutableWhen(query.state.data) ? Infinity : 0
      : staleTimeMs,
  };
}
