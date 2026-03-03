import { describe, it, expect, beforeEach } from 'vitest';
import { useEnclaveStore } from '../enclaveStore';

describe('enclaveStore', () => {
  beforeEach(() => {
    // Reset to default (null enclave)
    useEnclaveStore.setState({
      enclave: null,
      isLowSide: false,
      isHighSide: false,
      maxClassification: 'UNCLASSIFIED',
    });
  });

  it('has correct default state (single enclave mode)', () => {
    const state = useEnclaveStore.getState();
    expect(state.enclave).toBeNull();
    expect(state.isLowSide).toBe(false);
    expect(state.isHighSide).toBe(false);
    expect(state.maxClassification).toBe('UNCLASSIFIED');
  });

  it('setEnclave to high sets correct state', () => {
    useEnclaveStore.getState().setEnclave('high');
    const state = useEnclaveStore.getState();
    expect(state.enclave).toBe('high');
    expect(state.isHighSide).toBe(true);
    expect(state.isLowSide).toBe(false);
    expect(state.maxClassification).toBe('SECRET');
  });

  it('setEnclave to low sets correct state', () => {
    useEnclaveStore.getState().setEnclave('low');
    const state = useEnclaveStore.getState();
    expect(state.enclave).toBe('low');
    expect(state.isLowSide).toBe(true);
    expect(state.isHighSide).toBe(false);
    expect(state.maxClassification).toBe('CUI');
  });

  it('setEnclave to null resets to single-enclave mode', () => {
    useEnclaveStore.getState().setEnclave('high');
    useEnclaveStore.getState().setEnclave(null);
    const state = useEnclaveStore.getState();
    expect(state.enclave).toBeNull();
    expect(state.isHighSide).toBe(false);
    expect(state.isLowSide).toBe(false);
    expect(state.maxClassification).toBe('UNCLASSIFIED');
  });

  // M12: Cross-domain operations require enclave awareness
  describe('M12 cross-domain enclave enforcement', () => {
    it('high side allows SECRET classification', () => {
      useEnclaveStore.getState().setEnclave('high');
      const state = useEnclaveStore.getState();
      expect(state.maxClassification).toBe('SECRET');
    });

    it('low side maxes out at CUI classification', () => {
      useEnclaveStore.getState().setEnclave('low');
      const state = useEnclaveStore.getState();
      expect(state.maxClassification).toBe('CUI');
      // SECRET should never be accessible on low side
      expect(state.maxClassification).not.toBe('SECRET');
    });

    it('consolidated audit requires high side', () => {
      useEnclaveStore.getState().setEnclave('high');
      const state = useEnclaveStore.getState();
      // Consolidated audit is only available when isHighSide is true
      expect(state.isHighSide).toBe(true);
    });

    it('consolidated audit blocked on low side', () => {
      useEnclaveStore.getState().setEnclave('low');
      const state = useEnclaveStore.getState();
      expect(state.isHighSide).toBe(false);
    });

    it('cross-domain commands managed from high side only', () => {
      // On low side, the CrossDomainCommandPanel shows a placeholder
      useEnclaveStore.getState().setEnclave('low');
      expect(useEnclaveStore.getState().enclave).toBe('low');
      // This checks that the enclave is correctly tracked for conditional rendering
      expect(useEnclaveStore.getState().isHighSide).toBe(false);
    });

    it('finding enrichment/redaction available on high side', () => {
      useEnclaveStore.getState().setEnclave('high');
      const state = useEnclaveStore.getState();
      expect(state.isHighSide).toBe(true);
      // This verifies the store correctly marks the enclave for
      // UI conditional rendering (enrich/redact buttons visible on high)
    });

    it('finding sync-to-high available on low side', () => {
      useEnclaveStore.getState().setEnclave('low');
      const state = useEnclaveStore.getState();
      expect(state.isLowSide).toBe(true);
      // On the low side, the sync-to-high button should be visible
      expect(state.enclave).toBe('low');
    });
  });
});
