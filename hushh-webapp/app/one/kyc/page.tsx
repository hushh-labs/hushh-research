export default function OneKycPage() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return null; 
  }

  return (
    <VaultLockGuard>
      <OneKycWorkspace />
    </VaultLockGuard>
  );
}