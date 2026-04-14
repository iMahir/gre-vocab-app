import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  PermissionsAndroid,
  StatusBar as RNStatusBar,
  Text,
  TextInput,
  Vibration,
  View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Voice from '@react-native-voice/voice';
import * as Keychain from 'react-native-keychain';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import Tts from 'react-native-tts';

import LOCAL_WORDS from './GRE_Words.json';

const DATA_URL =
  'https://raw.githubusercontent.com/iMahir/gre-vocab-app/refs/heads/main/GRE_Words.json';

const STATE_LABELS = {
  mastered: 'Mastered',
  reviewing: 'Reviewing',
  learning: 'Learning' };

// UI Colors for states
const STATE_COLORS = {
  mastered: '#4CAF50', // Green
  reviewing: '#FF9800', // Orange
  learning: '#F44336', // Red
};

const STUDY_MODES = {
  flashcard: 'flashcard',
  quiz: 'quiz',
  speaking: 'speaking' };

const APP_SCREENS = {
  decks: 'decks',
  settings: 'settings' };

const AI_PROVIDERS = {
  gemini: 'gemini',
  openai: 'openai' };

const DEFAULT_MODELS = {
  [AI_PROVIDERS.gemini]: 'gemini-2.0-flash',
  [AI_PROVIDERS.openai]: 'gpt-4o-mini' };
const AI_KEYCHAIN_SERVICE = 'gre/ai-api-key';
const AI_KEYCHAIN_ACCOUNT = 'gre-ai-api-key';

const STORAGE_KEYS = {
  statuses: (groupName) => `gre/statuses/${groupName}`,
  cardIndex: (groupName) => `gre/card-index/${groupName}`,
  aiSettings: 'gre/ai-settings',
  wordsCache: 'gre/words-cache',
  wordsCacheAt: 'gre/words-cache-at',
  bookmarks: 'gre/bookmarks',
  dailyProgress: 'gre/daily-progress',
  dailyGoal: 'gre/daily-goal',
  ttsSlow: 'gre/tts-slow' };
const STORAGE_PREFIXES = {
  statuses: STORAGE_KEYS.statuses(''),
  cardIndex: STORAGE_KEYS.cardIndex('') };

// Minimum flex value so a zero-count segment stays visible as a sliver
const MIN_PROGRESS_FLEX = 0.01;
const QUIZ_SUMMARY_INTERVAL = 10;
const SWIPE_THRESHOLD = 90;
const QUIZ_AUTO_ADVANCE_DELAY_MS = 1200;
const INCORRECT_ANSWER_VIBRATION_MS = 120;
const CARD_MIN_HEIGHT = 300;
const CARD_BACK_TOP_PADDING = 72;
// Extra top spacing to keep content clear of Android status icons.
const ANDROID_STATUS_BAR_MARGIN = 10;
const DASHBOARD_MIN_SEGMENT_FLEX = 1;

const DEFAULT_DAILY_GOAL = 20;

function shuffleArray(values) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function normalizeCardIndex(index, total) {
  if (!total) {
    return 0;
  }
  return ((index % total) + total) % total;
}

function extractJsonObject(value) {
  if (!value) return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizePromptInput(value) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[{}[\]<>`"'\\]/g, ' ')
    .replace(/[:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function getErrorMessage(err, fallback) {
  if (!err) return fallback;
  if (err instanceof Error && err.message) return err.message;
  const message = err?.message || err?.error?.message;
  if (typeof message === 'string' && message.trim()) return message;
  try {
    return String(err);
  } catch {
    return fallback;
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pickWeightedNextIndex({
  words,
  currentIndex,
  statuses,
  bookmarks,
  bookmarksOnly,
}) {
  const total = Array.isArray(words) ? words.length : 0;
  if (!total) return 0;

  const candidates = [];
  for (let index = 0; index < total; index += 1) {
    const word = words[index]?.word;
    if (!word) continue;
    if (bookmarksOnly && !bookmarks?.[word]) continue;
    candidates.push(index);
  }
  if (!candidates.length) {
    return currentIndex ?? 0;
  }

  // Avoid immediate repeats when possible.
  const filtered = candidates.length > 1 ? candidates.filter((idx) => idx !== currentIndex) : candidates;
  const pool = filtered.length ? filtered : candidates;

  // Bias toward learning/reviewing, then unseen, then mastered.
  const weights = pool.map((idx) => {
    const w = words[idx]?.word;
    const state = statuses?.[w];
    if (state === 'learning') return 4;
    if (state === 'reviewing') return 3;
    if (state === 'mastered') return 1;
    return 2; // unseen
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (!totalWeight) return pool[0];

  let r = Math.random() * totalWeight;
  for (let i = 0; i < pool.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function normalizeSpeechEvaluation(result) {
  if (!result || typeof result !== 'object' || typeof result.feedback !== 'string') {
    throw new Error('AI returned malformed evaluation data.');
  }
  if (typeof result.match !== 'boolean') {
    throw new Error('AI response must include boolean field: match.');
  }

  const rawScore = Number(result.score);
  return {
    match: result.match,
    score: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, rawScore)) : 0,
    feedback: result.feedback.trim() || 'No feedback available.' };
}

async function evaluateWithGemini({ apiKey, model, prompt, signal }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey },
      signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1 } }) }
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Gemini request failed.');
  }

  const rawText = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text)
    .filter(Boolean)
    .join('\n');
  return extractJsonObject(rawText);
}

async function evaluateWithOpenAI({ apiKey, model, prompt, signal }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          // OpenAI JSON mode requires the word "JSON" to appear in the system message.
          content:
            'You grade vocabulary meaning answers. Return strict JSON with keys: match(boolean), score(number 0-100), feedback(string).' },
        { role: 'user', content: prompt },
      ] }) });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'OpenAI request failed.');
  }
  const rawText = payload?.choices?.[0]?.message?.content;
  return extractJsonObject(rawText);
}

async function transcribeWithOpenAI({ apiKey, audioUri, signal }) {
  const uriValue = String(audioUri || '').trim();
  if (!uriValue) {
    throw new Error('No recording found to transcribe.');
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uriValue);
  const normalizedUri = hasScheme ? uriValue : `file://${uriValue}`;

  const formData = new FormData();
  formData.append('file', {
    uri: normalizedUri,
    name: 'speech.m4a',
    type: 'audio/mp4',
  });
  formData.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'OpenAI transcription failed.');
  }
  const text = payload?.text;
  if (typeof text !== 'string') {
    throw new Error('OpenAI transcription returned no text.');
  }
  return text;
}

export default function App() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [appScreen, setAppScreen] = useState(APP_SCREENS.decks);
  const [wordsNotice, setWordsNotice] = useState('');

  const groupsRef = useRef([]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const [selectedGroupIndex, setSelectedGroupIndex] = useState(null);
  const [studyMode, setStudyMode] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [globalStatuses, setGlobalStatuses] = useState({});
  const [cardIndex, setCardIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [quizOptions, setQuizOptions] = useState([]);
  const [quizSelectedOption, setQuizSelectedOption] = useState('');
  const [quizResult, setQuizResult] = useState(null);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [quizSummary, setQuizSummary] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showBookmarkedOnly, setShowBookmarkedOnly] = useState(false);
  const [aiSettings, setAiSettings] = useState({
    provider: AI_PROVIDERS.gemini,
    model: DEFAULT_MODELS[AI_PROVIDERS.gemini],
    apiKey: '' });
  const [settingsDraft, setSettingsDraft] = useState({
    provider: AI_PROVIDERS.gemini,
    model: DEFAULT_MODELS[AI_PROVIDERS.gemini],
    apiKey: '',
    dailyGoal: String(DEFAULT_DAILY_GOAL) });

  const [dailyGoal, setDailyGoal] = useState(DEFAULT_DAILY_GOAL);
  const [dailyReviewed, setDailyReviewed] = useState(0);

  const dailyProgressDateRef = useRef(todayKey());

  const [bookmarks, setBookmarks] = useState({});
  const [deckResumeIndexes, setDeckResumeIndexes] = useState({});
  const [ttsSlow, setTtsSlow] = useState(false);
  const [speechTranscript, setSpeechTranscript] = useState('');
  const [speechInterim, setSpeechInterim] = useState('');
  const [speechError, setSpeechError] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isEvaluatingSpeech, setIsEvaluatingSpeech] = useState(false);
  const [speechEvaluation, setSpeechEvaluation] = useState(null);
  const [speechNativeBroken, setSpeechNativeBroken] = useState(false);
  const [isRecordingSpeech, setIsRecordingSpeech] = useState(false);
  const [isTranscribingSpeech, setIsTranscribingSpeech] = useState(false);

  const autoAdvanceRef = useRef(null);
  const swipeBusyRef = useRef(false);
  const speechEvalAbortRef = useRef(null);
  const speechEvalRequestIdRef = useRef(0);
  const speechTranscribeAbortRef = useRef(null);
  const speechTranscribeRequestIdRef = useRef(0);
  const flipAnim = useRef(new Animated.Value(0)).current;
  const pan = useRef(new Animated.ValueXY()).current;

  const selectedGroup =
    selectedGroupIndex === null ? null : groups[selectedGroupIndex] ?? null;
  const words = selectedGroup?.words ?? [];
  const totalWords = words.length;
  const topPadding =
    Platform.OS === 'android'
      ? (RNStatusBar.currentHeight ?? 0) + ANDROID_STATUS_BAR_MARGIN
      : 12;

  const uniqueDefinitionCount = useMemo(
    () =>
      new Set(
        groups
          .flatMap((group) => group.words ?? [])
          .map((item) => item.definition)
          .filter(Boolean)
      ).size,
    [groups]
  );
  const canPlayQuiz = uniqueDefinitionCount >= 4;

  const currentWord = useMemo(() => {
    const wordCount = words.length;
    if (!wordCount) {
      return null;
    }
    const normalizedIndex = normalizeCardIndex(cardIndex, wordCount);
    return words[normalizedIndex];
  }, [cardIndex, words]);

  const counts = useMemo(() => {
    return words.reduce(
      (acc, item) => {
        const state = statuses[item.word];
        if (state && acc[state] !== undefined) {
          acc[state] += 1;
        }
        return acc;
      },
      { mastered: 0, reviewing: 0, learning: 0 }
    );
  }, [statuses, words]);

  // Global Progress Logic
  const allWordsCount = useMemo(() => {
    return groups.reduce((acc, group) => acc + (group.words?.length || 0), 0);
  }, [groups]);

  const globalCounts = useMemo(() => {
    return Object.values(globalStatuses).reduce(
      (acc, state) => {
        if (acc[state] !== undefined) acc[state] += 1;
        return acc;
      },
      { mastered: 0, reviewing: 0, learning: 0 }
    );
  }, [globalStatuses]);

  const globalUnseenCount = useMemo(
    () =>
      Math.max(
        0,
        allWordsCount - globalCounts.mastered - globalCounts.reviewing - globalCounts.learning
      ),
    [allWordsCount, globalCounts]
  );

  const globalPercentages = useMemo(() => {
    if (!allWordsCount) {
      return { mastered: 0, reviewing: 0, learning: 0 };
    }
    return {
      mastered: Math.round((globalCounts.mastered / allWordsCount) * 100),
      reviewing: Math.round((globalCounts.reviewing / allWordsCount) * 100),
      learning: Math.round((globalCounts.learning / allWordsCount) * 100) };
  }, [allWordsCount, globalCounts]);

  // Search Logic
  const filteredSearchWords = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const lowerQuery = searchQuery.toLowerCase();
    return groups
      .flatMap((g, groupIndex) =>
        (g.words ?? []).map((w, wordIndex) => ({
          ...w,
          __groupIndex: groupIndex,
          __groupName: g.group,
          __wordIndex: wordIndex,
        }))
      )
      .filter((w) => w.word.toLowerCase().includes(lowerQuery));
  }, [searchQuery, groups]);

  const groupDeckStats = useMemo(() => {
    const stats = {};
    for (const group of groups) {
      const groupName = group?.group;
      if (!groupName) continue;
      const groupWords = group.words ?? [];
      const countsForGroup = groupWords.reduce(
        (acc, item) => {
          const state = globalStatuses[item.word];
          if (state && acc[state] !== undefined) acc[state] += 1;
          return acc;
        },
        { mastered: 0, reviewing: 0, learning: 0 }
      );
      const total = groupWords.length;
      const unseen = Math.max(0, total - countsForGroup.mastered - countsForGroup.reviewing - countsForGroup.learning);
      const resumeIndex = Number.isFinite(Number(deckResumeIndexes[groupName]))
        ? Math.max(0, Number(deckResumeIndexes[groupName]))
        : 0;
      const normalizedResume = total ? normalizeCardIndex(resumeIndex, total) : 0;
      const resumeWord = total ? groupWords[normalizedResume]?.word : '';
      stats[groupName] = {
        total,
        unseen,
        resumeIndex: normalizedResume,
        resumeWord,
        ...countsForGroup,
      };
    }
    return stats;
  }, [deckResumeIndexes, globalStatuses, groups]);

  const refreshGlobalStatuses = useCallback(async (groupsToScan) => {
    const scanGroups = Array.isArray(groupsToScan) ? groupsToScan : [];
    let allStatuses = {};
    for (const group of scanGroups) {
      const saved = await AsyncStorage.getItem(STORAGE_KEYS.statuses(group.group));
      if (!saved) continue;
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          allStatuses = { ...allStatuses, ...parsed };
        }
      } catch (err) {
        // Ignore corrupted saved statuses for one group.
        console.warn(
          'Ignoring corrupted saved group status data for group. Progress for this group may reset:',
          group.group,
          err
        );
      }
    }
    setGlobalStatuses(allStatuses);
  }, []);

  const loadWords = useCallback(async () => {
    const shouldBlock = (groupsRef.current?.length ?? 0) === 0;
    if (shouldBlock) {
      setLoading(true);
    }
    setError('');
    setWordsNotice('');

    const applyPayload = async (payload, notice) => {
      if (!Array.isArray(payload)) return;
      setGroups(payload);
      await refreshGlobalStatuses(payload);
      setWordsNotice(notice || '');

      try {
        const cardKeys = payload.map((g) => STORAGE_KEYS.cardIndex(g.group));
        const pairs = await AsyncStorage.multiGet(cardKeys);
        const map = {};
        for (const [key, value] of pairs) {
          const groupName = String(key || '').replace(STORAGE_PREFIXES.cardIndex, '');
          const parsedIndex = Number.parseInt(value ?? '0', 10);
          map[groupName] = Number.isFinite(parsedIndex) ? Math.max(0, parsedIndex) : 0;
        }
        setDeckResumeIndexes(map);
      } catch {
        // ignore
      }
    };

    // 1) Bootstrap from cache (fast startup)
    try {
      const cached = await AsyncStorage.getItem(STORAGE_KEYS.wordsCache);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length) {
          await applyPayload(parsed, 'Loaded cached words.');
        }
      } else if (Array.isArray(LOCAL_WORDS) && LOCAL_WORDS.length) {
        await applyPayload(LOCAL_WORDS, 'Loaded bundled words.');
      }
    } catch {
      if (Array.isArray(LOCAL_WORDS) && LOCAL_WORDS.length) {
        await applyPayload(LOCAL_WORDS, 'Loaded bundled words.');
      }
    }

    // 2) Refresh from remote
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch words (${response.status})`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Invalid words payload.');
      }
      await applyPayload(payload, 'Loaded latest words.');
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.wordsCache, JSON.stringify(payload)],
        [STORAGE_KEYS.wordsCacheAt, String(Date.now())],
      ]);
    } catch (err) {
      setError(getErrorMessage(err, 'Unable to load latest words.'));
      if ((groupsRef.current?.length ?? 0) === 0) {
        // Ensure we still show something even if cache + remote both failed.
        if (Array.isArray(LOCAL_WORDS) && LOCAL_WORDS.length) {
          await applyPayload(LOCAL_WORDS, 'Loaded bundled words.');
        }
      } else {
        setWordsNotice('Offline: using cached/bundled words.');
      }
    } finally {
      if (shouldBlock) {
        setLoading(false);
      }
    }
  }, [refreshGlobalStatuses]);

  useEffect(() => {
    loadWords();
  }, [loadWords]);

  useEffect(() => {
    const hydrateLocalPrefs = async () => {
      try {
        const [savedGoal, savedProgress, savedBookmarks, savedTtsSlow] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.dailyGoal),
          AsyncStorage.getItem(STORAGE_KEYS.dailyProgress),
          AsyncStorage.getItem(STORAGE_KEYS.bookmarks),
          AsyncStorage.getItem(STORAGE_KEYS.ttsSlow),
        ]);

        const parsedGoal = Number.parseInt(savedGoal ?? '', 10);
        const nextGoal = Number.isFinite(parsedGoal) && parsedGoal > 0 ? parsedGoal : DEFAULT_DAILY_GOAL;
        setDailyGoal(nextGoal);
        setSettingsDraft((prev) => ({ ...prev, dailyGoal: String(nextGoal) }));

        const progress = savedProgress ? JSON.parse(savedProgress) : null;
        const currentDate = todayKey();
        dailyProgressDateRef.current = currentDate;
        const nextReviewed =
          progress && progress.date === currentDate && Number.isFinite(Number(progress.count))
            ? Math.max(0, Number(progress.count))
            : 0;
        setDailyReviewed(nextReviewed);
        if (!progress || progress.date !== currentDate) {
          await AsyncStorage.setItem(
            STORAGE_KEYS.dailyProgress,
            JSON.stringify({ date: currentDate, count: 0 })
          );
        }

        const parsedBookmarks = savedBookmarks ? JSON.parse(savedBookmarks) : {};
        setBookmarks(parsedBookmarks && typeof parsedBookmarks === 'object' ? parsedBookmarks : {});

        setTtsSlow(savedTtsSlow === 'true');
      } catch {
        // ignore hydration errors
      }
    };
    hydrateLocalPrefs();
  }, []);

  const incrementDailyReviewed = useCallback((delta = 1) => {
    const currentDate = todayKey();
    setDailyReviewed((prev) => {
      const base = dailyProgressDateRef.current === currentDate ? prev : 0;
      const next = Math.max(0, base + delta);
      dailyProgressDateRef.current = currentDate;
      AsyncStorage.setItem(
        STORAGE_KEYS.dailyProgress,
        JSON.stringify({ date: currentDate, count: next })
      ).catch(() => {});
      return next;
    });
  }, []);

  const toggleBookmark = useCallback((word) => {
    const key = String(word || '').trim();
    if (!key) return;
    setBookmarks((prev) => {
      const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = true;
      }
      AsyncStorage.setItem(STORAGE_KEYS.bookmarks, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const speakWord = useCallback(async (word) => {
    const text = String(word || '').trim();
    if (!text) return;
    try {
      await Tts.stop();
      Tts.speak(text);
    } catch {
      Alert.alert('Pronunciation unavailable', 'Text-to-speech is not available on this device.');
    }
  }, []);

  useEffect(() => {
    // TTS init is best-effort; app should still work without it.
    Tts.setDefaultLanguage('en-US').catch(() => {});
    Tts.setDefaultRate(ttsSlow ? 0.35 : 0.5, true).catch(() => {});
    return () => {
      Tts.stop().catch(() => {});
    };
  }, [ttsSlow]);

  useEffect(() => {
    const hydrateSettings = async () => {
      try {
        const [saved, savedCredentials, savedGoal] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.aiSettings),
          Keychain.getGenericPassword({ service: AI_KEYCHAIN_SERVICE }),
          AsyncStorage.getItem(STORAGE_KEYS.dailyGoal),
        ]);
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!parsed || typeof parsed !== 'object') return;
        const provider =
          parsed.provider === AI_PROVIDERS.openai ? AI_PROVIDERS.openai : AI_PROVIDERS.gemini;
        const nextSettings = {
          provider,
          model: String(parsed.model || DEFAULT_MODELS[provider]),
          apiKey: savedCredentials?.password || '' };
        setAiSettings(nextSettings);
        const parsedGoal = Number.parseInt(savedGoal ?? '', 10);
        const nextGoal = Number.isFinite(parsedGoal) && parsedGoal > 0 ? parsedGoal : DEFAULT_DAILY_GOAL;
        setDailyGoal(nextGoal);
        setSettingsDraft({ ...nextSettings, dailyGoal: String(nextGoal) });
      } catch {
        setError('Could not load saved AI settings.');
      }
    };
    hydrateSettings();
  }, []);

  useEffect(() => {
    Animated.timing(flipAnim, {
      toValue: showDetails ? 1 : 0,
      duration: 320,
      useNativeDriver: true }).start();
  }, [flipAnim, showDetails]);

  useEffect(() => {
    return () => {
      if (autoAdvanceRef.current !== null) {
        clearTimeout(autoAdvanceRef.current);
      }
    };
  }, []);

  const resetQuizState = useCallback(() => {
    clearTimeout(autoAdvanceRef.current);
    autoAdvanceRef.current = null;
    setQuizOptions([]);
    setQuizSelectedOption('');
    setQuizResult(null);
    setQuizSummary(null);
  }, []);

  const resetSpeakingState = useCallback(() => {
    speechEvalRequestIdRef.current += 1;
    if (speechEvalAbortRef.current) {
      speechEvalAbortRef.current.abort();
      speechEvalAbortRef.current = null;
    }
    speechTranscribeRequestIdRef.current += 1;
    if (speechTranscribeAbortRef.current) {
      speechTranscribeAbortRef.current.abort();
      speechTranscribeAbortRef.current = null;
    }
    setSpeechTranscript('');
    setSpeechInterim('');
    setSpeechError('');
    setSpeechEvaluation(null);
    setIsEvaluatingSpeech(false);
    setIsTranscribingSpeech(false);
    setIsListening(false);
    setIsRecordingSpeech(false);
    Voice.cancel().catch((err) => {
      if (__DEV__) console.warn('Voice cancel failed', err);
    });
    AudioRecorderPlayer.stopRecorder().catch(() => {});
  }, []);

  useEffect(() => {
    Voice.onSpeechStart = () => {
      setIsListening(true);
      setSpeechError('');
    };
    Voice.onSpeechEnd = () => {
      setIsListening(false);
    };
    Voice.onSpeechError = (event) => {
      setIsListening(false);
      const message =
        event?.error?.message || event?.error?.code || 'Speech recognition failed.';
      setSpeechError(String(message));
    };
    Voice.onSpeechPartialResults = (event) => {
      const next = event?.value?.[0] || '';
      setSpeechInterim(next);
    };
    Voice.onSpeechResults = (event) => {
      const next = event?.value?.[0] || '';
      setSpeechTranscript(next);
      setSpeechInterim('');
    };

    return () => {
      speechEvalRequestIdRef.current += 1;
      if (speechEvalAbortRef.current) {
        speechEvalAbortRef.current.abort();
        speechEvalAbortRef.current = null;
      }
      speechTranscribeRequestIdRef.current += 1;
      if (speechTranscribeAbortRef.current) {
        speechTranscribeAbortRef.current.abort();
        speechTranscribeAbortRef.current = null;
      }
      Voice.cancel().catch(() => {});
      Voice.destroy()
        .then(() => Voice.removeAllListeners())
        .catch((err) => {
          if (__DEV__) console.warn('Voice cleanup failed', err);
        });
      AudioRecorderPlayer.stopRecorder().catch(() => {});
    };
  }, []);

  const persistGroupProgress = useCallback(
    async (nextStatuses, nextCardIndex) => {
      if (!selectedGroup) return;
      try {
        await AsyncStorage.multiSet([
          [
            STORAGE_KEYS.statuses(selectedGroup.group),
            JSON.stringify(nextStatuses ?? statuses),
          ],
          [
            STORAGE_KEYS.cardIndex(selectedGroup.group),
            String(nextCardIndex ?? cardIndex),
          ],
        ]);
        // Update global statuses for dashboard
        if (nextStatuses && typeof nextStatuses === 'object') {
          setGlobalStatuses((prev) => ({ ...prev, ...nextStatuses }));
        }
        if (nextCardIndex !== null && nextCardIndex !== undefined) {
          setDeckResumeIndexes((prev) => ({ ...prev, [selectedGroup.group]: Number(nextCardIndex) }));
        }
        incrementDailyReviewed(1);
      } catch {
        setError('Could not save progress locally.');
      }
    },
    [cardIndex, incrementDailyReviewed, selectedGroup, statuses]
  );

  const openGroup = useCallback(async (groupIndex, startIndexOverride = null) => {
    const group = groups[groupIndex];
    if (!group) return;

    setSelectedGroupIndex(groupIndex);
    setStudyMode(null);
    setShowDetails(false);
    flipAnim.setValue(0);
    pan.setValue({ x: 0, y: 0 });
    resetQuizState();
    resetSpeakingState();
    setQuizScore({ correct: 0, total: 0 });

    try {
      const [savedStatuses, savedCardIndex] = await AsyncStorage.multiGet([
        STORAGE_KEYS.statuses(group.group),
        STORAGE_KEYS.cardIndex(group.group),
      ]);

      let parsedStatuses = {};
      if (savedStatuses?.[1]) {
        try {
          parsedStatuses = JSON.parse(savedStatuses[1]);
        } catch {
          setError('Saved deck data was corrupted and has been reset.');
        }
      }
      const parsedCardIndex = Number.parseInt(savedCardIndex?.[1] ?? '0', 10);

      const overrideIndex = Number.isFinite(Number(startIndexOverride))
        ? Number(startIndexOverride)
        : null;
      const effectiveIndex = overrideIndex === null ? parsedCardIndex : overrideIndex;

      setStatuses(parsedStatuses && typeof parsedStatuses === 'object' ? parsedStatuses : {});
      setCardIndex(Math.max(Number.isNaN(effectiveIndex) ? 0 : effectiveIndex, 0));
    } catch {
      setStatuses({});
      setCardIndex(0);
      setError('Could not read saved progress for this deck.');
    }
  }, [flipAnim, groups, pan, resetQuizState, resetSpeakingState]);

  const backToDecks = useCallback(() => {
    setSelectedGroupIndex(null);
    setStudyMode(null);
    setShowDetails(false);
    flipAnim.setValue(0);
    pan.setValue({ x: 0, y: 0 });
    resetQuizState();
    resetSpeakingState();
    setQuizScore({ correct: 0, total: 0 });
    setSearchQuery('');
  }, [flipAnim, pan, resetQuizState, resetSpeakingState]);

  const resetSelectedDeckState = useCallback(() => {
    setStatuses({});
    setCardIndex(0);
    setStudyMode(null);
    setShowDetails(false);
    flipAnim.setValue(0);
    pan.setValue({ x: 0, y: 0 });
    resetQuizState();
    resetSpeakingState();
    setQuizScore({ correct: 0, total: 0 });
  }, [flipAnim, pan, resetQuizState, resetSpeakingState]);

  const confirmResetGroupProgress = useCallback(
    (group) => {
      if (!group?.group) return;

      Alert.alert(
        'Reset Group Progress',
        `This will clear your saved progress for ${group.group}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Reset',
            style: 'destructive',
            onPress: async () => {
              try {
                await AsyncStorage.multiRemove([
                  STORAGE_KEYS.statuses(group.group),
                  STORAGE_KEYS.cardIndex(group.group),
                ]);
                setDeckResumeIndexes((prev) => ({ ...prev, [group.group]: 0 }));
                if (selectedGroup?.group === group.group) {
                  resetSelectedDeckState();
                }
                await refreshGlobalStatuses(groups);
                setError('');
              } catch (err) {
                console.warn('Failed resetting group progress.', err);
                setError('Could not reset progress for this group.');
              }
            } },
        ]
      );
    },
    [groups, refreshGlobalStatuses, resetSelectedDeckState, selectedGroup]
  );

  const confirmResetAllProgress = useCallback(() => {
    Alert.alert(
      'Reset All Progress',
      'This will clear all saved progress for every group.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset All',
          style: 'destructive',
          onPress: async () => {
            try {
              const allStorageKeys = await AsyncStorage.getAllKeys();
              const progressKeys = allStorageKeys.filter(
                (key) =>
                  key.startsWith(STORAGE_PREFIXES.statuses) ||
                  key.startsWith(STORAGE_PREFIXES.cardIndex)
              );
              if (progressKeys.length) {
                await AsyncStorage.multiRemove(progressKeys);
              }
              setDeckResumeIndexes({});
              resetSelectedDeckState();
              await refreshGlobalStatuses(groups);
              setError('');
            } catch (err) {
              console.warn('Failed resetting all progress.', err);
              setError('Could not reset all progress.');
            }
          } },
      ]
    );
  }, [groups, refreshGlobalStatuses, resetSelectedDeckState]);

  useEffect(() => {
    if (!currentWord || studyMode !== STUDY_MODES.quiz) {
      resetQuizState();
      return;
    }

    const correctDefinition = currentWord.definition;
    const allDefinitions = Array.from(
      new Set(
        groups
          .flatMap((group) => group.words ?? [])
          .map((item) => item.definition)
          .filter((definition) => definition && definition !== correctDefinition)
      )
    );

    const deckDefinitions = Array.from(
      new Set(
        words
          .filter((item) => item.word !== currentWord.word)
          .map((item) => item.definition)
          .filter((definition) => definition && definition !== correctDefinition)
      )
    );

    const incorrectDefinitions = shuffleArray(
      Array.from(new Set([...deckDefinitions, ...allDefinitions]))
    ).slice(0, 3);

    if (incorrectDefinitions.length < 3) {
      resetQuizState();
      return;
    }

    setQuizOptions(shuffleArray([correctDefinition, ...incorrectDefinitions]));
    setQuizSelectedOption('');
    setQuizResult(null);
  }, [currentWord, groups, resetQuizState, studyMode, words]);

  const classifyWord = useCallback(
    async (state) => {
      if (!currentWord || !selectedGroup) return;

      const nextStatuses = { ...statuses, [currentWord.word]: state };
      if (!totalWords) return;

      const normalizedCardIndex = normalizeCardIndex(cardIndex, totalWords);
      const nextCardIndex = pickWeightedNextIndex({
        words,
        currentIndex: normalizedCardIndex,
        statuses: nextStatuses,
        bookmarks,
        bookmarksOnly: showBookmarkedOnly,
      });

      setStatuses(nextStatuses);
      setCardIndex(nextCardIndex);
      setShowDetails(false);
      flipAnim.setValue(0);
      pan.setValue({ x: 0, y: 0 });
      await persistGroupProgress(nextStatuses, nextCardIndex);
    },
    [
      bookmarks,
      cardIndex,
      currentWord,
      flipAnim,
      pan,
      persistGroupProgress,
      selectedGroup,
      showBookmarkedOnly,
      statuses,
      totalWords,
      words,
    ]
  );

  const classifyBySwipe = useCallback(
    (state, toValue) => {
      if (swipeBusyRef.current) return;
      swipeBusyRef.current = true;

      Animated.timing(pan, {
        toValue,
        duration: 180,
        useNativeDriver: true }).start(async () => {
        await classifyWord(state);
        pan.setValue({ x: 0, y: 0 });
        swipeBusyRef.current = false;
      });
    },
    [classifyWord, pan]
  );

  const resetSwipePosition = useCallback(() => {
    Animated.spring(pan, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: true,
      friction: 6 }).start();
  }, [pan]);

  const saveAiSettings = useCallback(async () => {
    const provider =
      settingsDraft.provider === AI_PROVIDERS.openai ? AI_PROVIDERS.openai : AI_PROVIDERS.gemini;
    const nextSettings = {
      provider,
      model: settingsDraft.model.trim() || DEFAULT_MODELS[provider],
      apiKey: settingsDraft.apiKey.trim() };
    try {
      await Keychain.setGenericPassword(AI_KEYCHAIN_ACCOUNT, nextSettings.apiKey, {
        service: AI_KEYCHAIN_SERVICE });
      await AsyncStorage.setItem(
        STORAGE_KEYS.aiSettings,
        JSON.stringify({ provider: nextSettings.provider, model: nextSettings.model })
      );

      const parsedGoal = Number.parseInt(String(settingsDraft.dailyGoal ?? ''), 10);
      const nextGoal = Number.isFinite(parsedGoal) && parsedGoal > 0 ? parsedGoal : DEFAULT_DAILY_GOAL;
      await AsyncStorage.setItem(STORAGE_KEYS.dailyGoal, String(nextGoal));

      setAiSettings(nextSettings);
      setDailyGoal(nextGoal);
      setSettingsDraft({ ...nextSettings, dailyGoal: String(nextGoal) });
      setError('');
      Alert.alert('Saved', 'AI settings saved successfully.');
    } catch {
      setError('Could not save AI settings.');
    }
  }, [settingsDraft]);

  const ensureMicrophonePermission = useCallback(async () => {
    if (Platform.OS !== 'android') return true;
    try {
      const hasPermission = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      if (hasPermission) return true;
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone permission',
          message: 'We need microphone access to transcribe your spoken meaning.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        }
      );
      return permission === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!currentWord) return;
    try {
      const hasMicrophonePermission = await ensureMicrophonePermission();
      if (!hasMicrophonePermission) {
        setSpeechError('Microphone permission is required.');
        return;
      }
      // Some devices incorrectly report speech as unavailable; attempt start and fallback if it fails.
      setSpeechNativeBroken(false);

      setIsRecordingSpeech(false);
      setIsTranscribingSpeech(false);
      AudioRecorderPlayer.stopRecorder().catch(() => {});
      speechTranscribeRequestIdRef.current += 1;
      if (speechTranscribeAbortRef.current) {
        speechTranscribeAbortRef.current.abort();
        speechTranscribeAbortRef.current = null;
      }

      if (speechEvalAbortRef.current) {
        speechEvalAbortRef.current.abort();
        speechEvalAbortRef.current = null;
      }
      speechEvalRequestIdRef.current += 1;
      setIsEvaluatingSpeech(false);
      await Voice.cancel().catch(() => {});
      setSpeechTranscript('');
      setSpeechInterim('');
      setSpeechError('');
      setSpeechEvaluation(null);
      await Voice.start('en-US');
    } catch (err) {
      setSpeechNativeBroken(true);
      setSpeechError(getErrorMessage(err, 'Could not start voice recognition.'));
    }
  }, [currentWord, ensureMicrophonePermission]);

  const stopListening = useCallback(async () => {
    try {
      await Voice.stop();
    } catch {
      setSpeechError('Could not stop voice recognition.');
    }
  }, []);

  const startSpeechRecording = useCallback(async () => {
    if (!currentWord) return;
    try {
      const hasMicrophonePermission = await ensureMicrophonePermission();
      if (!hasMicrophonePermission) {
        setSpeechError('Microphone permission is required.');
        return;
      }

      if (aiSettings.provider !== AI_PROVIDERS.openai) {
        setSpeechError(
          'Cloud transcription requires ChatGPT provider. Open Settings, switch to ChatGPT, save an OpenAI API key, then try again.'
        );
        return;
      }
      if (!aiSettings.apiKey.trim()) {
        setSpeechError('OpenAI API key is required for cloud transcription.');
        return;
      }

      speechEvalRequestIdRef.current += 1;
      if (speechEvalAbortRef.current) {
        speechEvalAbortRef.current.abort();
        speechEvalAbortRef.current = null;
      }

      speechTranscribeRequestIdRef.current += 1;
      if (speechTranscribeAbortRef.current) {
        speechTranscribeAbortRef.current.abort();
        speechTranscribeAbortRef.current = null;
      }

      await Voice.cancel().catch(() => {});
      setIsListening(false);

      setSpeechTranscript('');
      setSpeechInterim('');
      setSpeechError('');
      setSpeechEvaluation(null);
      setIsEvaluatingSpeech(false);
      setIsTranscribingSpeech(false);

      setIsRecordingSpeech(true);
      await AudioRecorderPlayer.startRecorder();
    } catch (err) {
      setIsRecordingSpeech(false);
      setSpeechError(getErrorMessage(err, 'Could not start recording.'));
    }
  }, [aiSettings, currentWord, ensureMicrophonePermission]);

  const stopSpeechRecording = useCallback(async () => {
    let controller = null;
    try {
      const audioUri = await AudioRecorderPlayer.stopRecorder();
      setIsRecordingSpeech(false);

      if (aiSettings.provider !== AI_PROVIDERS.openai) {
        setSpeechError(
          'Cloud transcription requires ChatGPT provider. Open Settings, switch to ChatGPT, save an OpenAI API key, then try again.'
        );
        return;
      }
      if (!aiSettings.apiKey.trim()) {
        setSpeechError('OpenAI API key is required for cloud transcription.');
        return;
      }

      const requestId = speechTranscribeRequestIdRef.current + 1;
      speechTranscribeRequestIdRef.current = requestId;

      if (speechTranscribeAbortRef.current) {
        speechTranscribeAbortRef.current.abort();
      }

      controller = typeof AbortController === 'function' ? new AbortController() : null;
      speechTranscribeAbortRef.current = controller;

      setIsTranscribingSpeech(true);
      setSpeechError('');

      const text = await transcribeWithOpenAI({
        apiKey: aiSettings.apiKey.trim(),
        audioUri,
        signal: controller?.signal,
      });

      if (speechTranscribeRequestIdRef.current === requestId) {
        setSpeechTranscript(String(text || '').trim());
        setSpeechInterim('');
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return;
      }
      setSpeechError(getErrorMessage(err, 'Could not transcribe your recording.'));
    } finally {
      setIsTranscribingSpeech(false);
      if (speechTranscribeAbortRef.current === controller) {
        speechTranscribeAbortRef.current = null;
      }
    }
  }, [aiSettings]);

  const evaluateSpeechAnswer = useCallback(async () => {
    if (!currentWord) return;
    const spokenAnswer = sanitizePromptInput(speechTranscript || speechInterim);
    if (!spokenAnswer) {
      setSpeechError('Please speak your meaning first.');
      return;
    }
    if (!aiSettings.model.trim()) {
      setSpeechError('Model name is required. Open Settings and save it first.');
      return;
    }
    if (!aiSettings.apiKey.trim()) {
      setSpeechError('API key is required. Open Settings and save it first.');
      return;
    }

    const safeWord = sanitizePromptInput(currentWord.word);
    const safeDefinition = sanitizePromptInput(currentWord.definition);
    const prompt = `Evaluate whether the user's meaning for a GRE word is roughly correct.
Word: ${safeWord}
Correct meaning: ${safeDefinition}
User spoken meaning: ${spokenAnswer}

Return JSON only:
{
  "match": boolean,
  "score": number,
  "feedback": "brief actionable feedback in <= 2 sentences"
}`;

    try {
      setIsEvaluatingSpeech(true);
      setSpeechError('');

      const requestId = speechEvalRequestIdRef.current + 1;
      speechEvalRequestIdRef.current = requestId;

      if (speechEvalAbortRef.current) {
        speechEvalAbortRef.current.abort();
      }
      const controller =
        typeof AbortController === 'function' ? new AbortController() : null;
      speechEvalAbortRef.current = controller;

      let result = null;
      if (aiSettings.provider === AI_PROVIDERS.gemini) {
        result = await evaluateWithGemini({
          apiKey: aiSettings.apiKey.trim(),
          model: aiSettings.model.trim(),
          prompt,
          signal: controller?.signal });
      } else {
        result = await evaluateWithOpenAI({
          apiKey: aiSettings.apiKey.trim(),
          model: aiSettings.model.trim(),
          prompt,
          signal: controller?.signal });
      }
      if (!result) {
        throw new Error('AI returned an unreadable response.');
      }
      const normalized = normalizeSpeechEvaluation(result);
      if (speechEvalRequestIdRef.current === requestId) {
        setSpeechEvaluation(normalized);
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return;
      }
      if (speechEvalRequestIdRef.current === requestId) {
        setSpeechError(getErrorMessage(err, 'Could not evaluate your spoken answer.'));
      }
    } finally {
      if (speechEvalRequestIdRef.current === requestId) {
        setIsEvaluatingSpeech(false);
      }
      if (speechEvalAbortRef.current === controller) {
        speechEvalAbortRef.current = null;
      }
    }
  }, [aiSettings, currentWord, speechInterim, speechTranscript]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          studyMode === STUDY_MODES.flashcard &&
          (Math.abs(gestureState.dx) > 8 || Math.abs(gestureState.dy) > 8),
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false }),
        onPanResponderRelease: (_, gestureState) => {
          const { dx, dy } = gestureState;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);

          if (absDx > absDy && dx >= SWIPE_THRESHOLD) {
            classifyBySwipe('mastered', { x: 500, y: 0 });
            return;
          }
          if (absDx > absDy && dx <= -SWIPE_THRESHOLD) {
            classifyBySwipe('learning', { x: -500, y: 0 });
            return;
          }
          if (dy >= SWIPE_THRESHOLD) {
            classifyBySwipe('reviewing', { x: 0, y: 500 });
            return;
          }
          resetSwipePosition();
        } }),
    [classifyBySwipe, pan.x, pan.y, resetSwipePosition, studyMode]
  );

  const selectMode = useCallback(
    async (mode) => {
      if (mode === STUDY_MODES.quiz && !canPlayQuiz) return;
      if (mode === STUDY_MODES.speaking && Platform.OS === 'android') {
        const hasPermission = await ensureMicrophonePermission();
        if (!hasPermission) {
          setSpeechError('Microphone permission is required for speaking mode.');
        }
      }
      setStudyMode(mode);
      setShowDetails(false);
      flipAnim.setValue(0);
      pan.setValue({ x: 0, y: 0 });
      resetQuizState();
      resetSpeakingState();
    },
    [canPlayQuiz, ensureMicrophonePermission, flipAnim, pan, resetQuizState, resetSpeakingState]
  );

  const backToModes = useCallback(() => {
    setStudyMode(null);
    setShowDetails(false);
    flipAnim.setValue(0);
    pan.setValue({ x: 0, y: 0 });
    resetQuizState();
    resetSpeakingState();
  }, [flipAnim, pan, resetQuizState, resetSpeakingState]);

  const nextQuizWord = useCallback(async () => {
    if (!totalWords) return;
    const normalizedCardIndex = normalizeCardIndex(cardIndex, totalWords);
    const nextCardIndex = pickWeightedNextIndex({
      words,
      currentIndex: normalizedCardIndex,
      statuses,
      bookmarks,
      bookmarksOnly: showBookmarkedOnly,
    });
    setCardIndex(nextCardIndex);
    setQuizResult(null);
    setQuizSelectedOption('');
    setQuizSummary(null);
    await persistGroupProgress(statuses, nextCardIndex);
  }, [bookmarks, cardIndex, persistGroupProgress, showBookmarkedOnly, statuses, totalWords, words]);

  const submitQuizAnswer = useCallback(
    (selectedDefinition) => {
      if (!currentWord || quizResult !== null) return;

      const isCorrect = selectedDefinition === currentWord.definition;
      const nextCorrect = quizScore.correct + (isCorrect ? 1 : 0);
      const nextTotal = quizScore.total + 1;
      setQuizSelectedOption(selectedDefinition);
      setQuizResult(isCorrect ? 'correct' : 'incorrect');
      setQuizScore({ correct: nextCorrect, total: nextTotal });

      if (!isCorrect) {
        Vibration.vibrate(INCORRECT_ANSWER_VIBRATION_MS);
      }

      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = setTimeout(() => {
        autoAdvanceRef.current = null;
        if (nextTotal % QUIZ_SUMMARY_INTERVAL === 0) {
          setQuizSummary({
            correct: nextCorrect,
            total: nextTotal,
            accuracy: Math.round((nextCorrect / nextTotal) * 100) });
          return;
        }
        nextQuizWord();
      }, QUIZ_AUTO_ADVANCE_DELAY_MS);
    },
    [currentWord, nextQuizWord, quizResult, quizScore.correct, quizScore.total]
  );

  const isCurrentBookmarked = currentWord?.word ? Boolean(bookmarks?.[currentWord.word]) : false;
  const pronunciationButton = currentWord ? (
    <View style={styles.cardTopLeftRow}>
      <Pressable
        style={styles.audioIcon}
        onPress={() => speakWord(currentWord.word)}
        accessibilityLabel="Play pronunciation"
      >
        <Text style={styles.audioIconText}>🔊</Text>
      </Pressable>
      <Pressable
        style={styles.audioIcon}
        onPress={() => toggleBookmark(currentWord.word)}
        accessibilityLabel={isCurrentBookmarked ? 'Remove bookmark' : 'Bookmark word'}
      >
        <Text style={styles.audioIconText}>{isCurrentBookmarked ? '★' : '☆'}</Text>
      </Pressable>
    </View>
  ) : null;

  const frontInterpolate = flipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'] });
  const backInterpolate = flipAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['180deg', '360deg'] });
  const swipeRotate = pan.x.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: ['-8deg', '0deg', '8deg'],
    extrapolate: 'clamp' });

  if (loading) {
    return (
      <SafeAreaView style={styles.base}>
        <RNStatusBar barStyle="light-content" backgroundColor="#050505" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.infoText}>Loading GRE words...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.base}>
      <RNStatusBar barStyle="light-content" backgroundColor="#050505" />
      <View style={[styles.container, { paddingTop: topPadding }]}>
        <View style={styles.appHeaderRow}>
          <Text style={styles.appTitle}>GRE Vocab</Text>
          {!selectedGroup ? (
            <Pressable
              style={styles.settingsTopButton}
              onPress={() =>
                setAppScreen((prev) =>
                  prev === APP_SCREENS.settings ? APP_SCREENS.decks : APP_SCREENS.settings
                )
              }
            >
              <Text style={styles.settingsTopButtonText}>
                {appScreen === APP_SCREENS.settings ? 'Decks' : 'Settings'}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={loadWords}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {selectedGroup ? (
          <View style={styles.deckScreen}>
            <View style={styles.headerRow}>
              <Pressable onPress={studyMode ? backToModes : backToDecks}>
                <Text style={styles.backText}>{studyMode ? '← Modes' : '← Decks'}</Text>
              </Pressable>
              <Text style={styles.groupTitle}>{selectedGroup.group}</Text>
            </View>

            <View style={styles.deckFiltersRow}>
              <Pressable
                style={[styles.filterPill, showBookmarkedOnly ? styles.filterPillActive : null]}
                onPress={() => {
                  if (!showBookmarkedOnly) {
                    const hasAny = words.some((w) => bookmarks?.[w.word]);
                    if (!hasAny) {
                      Alert.alert('No bookmarks yet', 'Bookmark a word (☆) first, then enable ★ Only.');
                      return;
                    }
                    const nextIndex = pickWeightedNextIndex({
                      words,
                      currentIndex: normalizeCardIndex(cardIndex, totalWords),
                      statuses,
                      bookmarks,
                      bookmarksOnly: true,
                    });
                    setCardIndex(nextIndex);
                  }
                  setShowBookmarkedOnly((prev) => !prev);
                }}
              >
                <Text style={styles.filterPillText}>★ Only</Text>
              </Pressable>
              <Text style={styles.deckFiltersMeta}>
                Today: {dailyReviewed}/{dailyGoal}
              </Text>
            </View>

            {/* Compact Progress Bar */}
            {studyMode === STUDY_MODES.flashcard && (
              <View style={styles.compactProgressArea}>
                {['mastered', 'reviewing', 'learning'].map((stateKey) => (
                  <View
                    key={stateKey}
                    style={[
                      styles.compactProgressSegment,
                      {
                        backgroundColor: STATE_COLORS[stateKey],
                        flex: counts[stateKey] || MIN_PROGRESS_FLEX },
                    ]}
                  />
                ))}
              </View>
            )}

            {!studyMode ? (
              <View style={styles.modeList}>
                <Text style={styles.sectionTitle}>Choose a study mode</Text>
                <Pressable
                  style={styles.modeCard}
                  onPress={() => selectMode(STUDY_MODES.flashcard)}
                >
                  <Text style={styles.modeCardTitle}>Flash Cards</Text>
                  <Text style={styles.modeCardMeta}>
                    Tap to reveal details and mark each word.
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modeCard, !canPlayQuiz && styles.modeCardDisabled]}
                  onPress={() => selectMode(STUDY_MODES.quiz)}
                  disabled={!canPlayQuiz}
                >
                  <Text style={styles.modeCardTitle}>Meaning Quiz</Text>
                  <Text style={styles.modeCardMeta}>
                    Choose the correct definition from options.
                  </Text>
                </Pressable>
                <Pressable style={styles.modeCard} onPress={() => selectMode(STUDY_MODES.speaking)}>
                  <Text style={styles.modeCardTitle}>Voice Meaning Check</Text>
                  <Text style={styles.modeCardMeta}>
                    Speak the meaning and get AI feedback.
                  </Text>
                </Pressable>
              </View>
            ) : currentWord ? (
              <>
                {studyMode === STUDY_MODES.flashcard ? (
                  <>
                    <Animated.View
                      style={[
                        styles.cardFlipContainer,
                        {
                          transform: [
                            { translateX: pan.x },
                            { translateY: pan.y },
                            { rotate: swipeRotate },
                          ] },
                      ]}
                      {...panResponder.panHandlers}
                    >
                      <Pressable
                        style={styles.cardTapLayer}
                        onPress={() => setShowDetails((prev) => !prev)}
                      >
                        <Animated.View
                          style={[
                            styles.card,
                            styles.cardFace,
                            {
                              transform: [{ perspective: 1000 }, { rotateY: frontInterpolate }] },
                          ]}
                        >
                          <View style={styles.cardTopRow}>
                            {pronunciationButton}
                            <View
                              style={[
                                styles.cardTag,
                                {
                                  backgroundColor:
                                    STATE_COLORS[statuses[currentWord.word]] || '#212121' },
                              ]}
                            >
                              <Text style={styles.cardTagText}>
                                {STATE_LABELS[statuses[currentWord.word]] ?? 'Unseen'}
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.wordText}>{currentWord.word}</Text>
                          <Text style={styles.tapHint}>Tap to reveal meaning</Text>
                          <Text style={styles.swipeHint}>
                            Swipe ← Learn • ↓ Review • → I Know
                          </Text>
                        </Animated.View>

                        <Animated.View
                          style={[
                            styles.card,
                            styles.cardFace,
                            styles.cardBack,
                            {
                              transform: [{ perspective: 1000 }, { rotateY: backInterpolate }] },
                          ]}
                        >
                          <View style={styles.cardTopRow}>
                            {pronunciationButton}
                            <View
                              style={[
                                styles.cardTag,
                                {
                                  backgroundColor:
                                    STATE_COLORS[statuses[currentWord.word]] || '#212121' },
                              ]}
                            >
                              <Text style={styles.cardTagText}>
                                {STATE_LABELS[statuses[currentWord.word]] ?? 'Unseen'}
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.wordText}>{currentWord.word}</Text>
                          <ScrollView
                            style={styles.detailsScroll}
                            contentContainerStyle={styles.detailsWrap}
                            showsVerticalScrollIndicator={false}
                          >
                            <Text style={styles.definitionText}>
                              <Text style={styles.posText}>{currentWord.part_of_speech} </Text>
                              {currentWord.definition}
                            </Text>
                            {currentWord.example && (
                              <Text style={styles.exampleText}>"{currentWord.example}"</Text>
                            )}
                            {currentWord.mnemonic && (
                              <View style={styles.mnemonicBox}>
                                <Text style={styles.mnemonicTitle}>Mnemonic:</Text>
                                <Text style={styles.mnemonicText}>{currentWord.mnemonic}</Text>
                              </View>
                            )}
                            {currentWord.synonyms?.length > 0 && (
                              <Text style={styles.synonymsText}>
                                Synonyms: {currentWord.synonyms.join(', ')}
                              </Text>
                            )}
                          </ScrollView>
                        </Animated.View>
                      </Pressable>
                    </Animated.View>

                    <View style={styles.actionRow}>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.learning }]}
                        onPress={() => classifyWord('learning')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.learning }]}>
                          Learn
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.reviewing }]}
                        onPress={() => classifyWord('reviewing')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.reviewing }]}>
                          Review
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.mastered }]}
                        onPress={() => classifyWord('mastered')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.mastered }]}>
                          I Know
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : studyMode === STUDY_MODES.quiz ? (
                  <View style={styles.quizWrap}>
                    <View style={styles.card}>
                      <View style={styles.cardTopRow}>{pronunciationButton}</View>
                      <Text style={styles.quizPrompt}>Choose the correct meaning</Text>
                      <Text style={styles.wordText}>{currentWord.word}</Text>
                    </View>

                    <View style={styles.quizOptionsWrap}>
                      {quizOptions.map((option) => {
                        const isSelected = quizSelectedOption === option;
                        const isCorrectOption = option === currentWord.definition;
                        return (
                          <Pressable
                            key={option}
                            style={[
                              styles.quizOption,
                              isSelected && !isCorrectOption && styles.quizOptionWrong,
                              quizSelectedOption && isCorrectOption && styles.quizOptionCorrect,
                            ]}
                            onPress={() => submitQuizAnswer(option)}
                          >
                            <Text style={styles.quizOptionText}>{option}</Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {quizResult === 'incorrect' && (
                      <View style={styles.quizFeedback}>
                        <Text style={styles.quizFeedbackTitle}>Not quite ❌</Text>
                        <Text style={styles.quizFeedbackText}>
                          Answer: {currentWord.definition}
                        </Text>
                        <Pressable style={styles.nextButton} onPress={nextQuizWord}>
                          <Text style={styles.nextButtonText}>Next Word</Text>
                        </Pressable>
                      </View>
                    )}

                    <Text style={styles.quizScoreText}>
                      Score: {quizScore.correct}/{quizScore.total}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.quizWrap}>
                    <View style={styles.card}>
                      <View style={styles.cardTopRow}>{pronunciationButton}</View>
                      <Text style={styles.quizPrompt}>Speak the meaning of this word</Text>
                      <Text style={styles.wordText}>{currentWord.word}</Text>
                    </View>

                    <View style={styles.speakingPanel}>
                      <Pressable
                        style={[
                          styles.nextButton,
                          isListening ? styles.speakingButtonActive : styles.speakingButton,
                          (isEvaluatingSpeech || isTranscribingSpeech || isRecordingSpeech) && !isListening
                            ? { opacity: 0.6 }
                            : null,
                        ]}
                        onPress={isListening ? stopListening : startListening}
                        disabled={
                          (isEvaluatingSpeech || isTranscribingSpeech || isRecordingSpeech) && !isListening
                        }
                      >
                        <Text style={styles.nextButtonText}>
                          {isListening ? 'Stop Listening' : 'Start Speaking'}
                        </Text>
                      </Pressable>

                      {speechNativeBroken ? (
                        <Text style={styles.modeCardMeta}>
                          Device speech recognition isn’t available on this device. Use Record & Transcribe.
                        </Text>
                      ) : null}

                      <Pressable
                        style={[
                          styles.nextButton,
                          isRecordingSpeech ? styles.speakingButtonActive : styles.speakingButton,
                          isListening || isEvaluatingSpeech || isTranscribingSpeech ? { opacity: 0.6 } : null,
                        ]}
                        onPress={isRecordingSpeech ? stopSpeechRecording : startSpeechRecording}
                        disabled={isListening || isEvaluatingSpeech || isTranscribingSpeech}
                      >
                        <Text style={styles.nextButtonText}>
                          {isTranscribingSpeech
                            ? 'Transcribing...'
                            : isRecordingSpeech
                              ? 'Stop Recording'
                              : 'Record & Transcribe'}
                        </Text>
                      </Pressable>

                      <Text style={styles.speakingTranscriptLabel}>Transcript</Text>
                      <Text style={styles.speakingTranscriptValue}>
                        {speechTranscript || speechInterim || 'Your spoken answer will appear here.'}
                      </Text>
                      {speechError ? <Text style={styles.speakingError}>{speechError}</Text> : null}
                      <Pressable
                        style={[
                          styles.nextButton,
                          styles.speakingCheckButton,
                          isEvaluatingSpeech || isListening || isRecordingSpeech || isTranscribingSpeech
                            ? { opacity: 0.6 }
                            : null,
                        ]}
                        onPress={evaluateSpeechAnswer}
                        disabled={isEvaluatingSpeech || isListening || isRecordingSpeech || isTranscribingSpeech}
                      >
                        <Text style={styles.nextButtonText}>
                          {isListening
                            ? 'Stop Listening First'
                            : isRecordingSpeech
                              ? 'Stop Recording First'
                              : isTranscribingSpeech
                                ? 'Wait for Transcript'
                            : isEvaluatingSpeech
                              ? 'Checking...'
                              : 'Check with AI'}
                        </Text>
                      </Pressable>

                      {speechEvaluation ? (
                        <View style={styles.speechResultCard}>
                          <Text
                            style={[
                              styles.speechResultTitle,
                              speechEvaluation.match
                                ? styles.speechResultGood
                                : styles.speechResultBad,
                            ]}
                          >
                            {speechEvaluation.match ? 'Great Match ✅' : 'Needs Improvement ❌'}
                          </Text>
                          <Text style={styles.quizFeedbackText}>
                            Score: {speechEvaluation.score}/100
                          </Text>
                          <Text style={styles.quizFeedbackText}>{speechEvaluation.feedback}</Text>
                        </View>
                      ) : null}
                    </View>

                    <View style={styles.actionRow}>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.learning }]}
                        onPress={() => classifyWord('learning')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.learning }]}>
                          Learn
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.reviewing }]}
                        onPress={() => classifyWord('reviewing')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.reviewing }]}>
                          Review
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.mastered }]}
                        onPress={() => classifyWord('mastered')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.mastered }]}>
                          I Know
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </>
            ) : null}
          </View>
        ) : appScreen === APP_SCREENS.settings ? (
          <View style={styles.settingsScreen}>
            <Text style={styles.sectionTitle}>AI Settings</Text>
            <Text style={styles.modeCardMeta}>
              Choose your provider, model, and API key for voice answer checks.
            </Text>

            <View style={styles.settingsProviderRow}>
              <Pressable
                style={[
                  styles.settingsProviderButton,
                  settingsDraft.provider === AI_PROVIDERS.gemini && styles.settingsProviderButtonActive,
                ]}
                onPress={() =>
                  setSettingsDraft((prev) => ({
                    ...prev,
                    provider: AI_PROVIDERS.gemini,
                    model:
                      prev.provider === AI_PROVIDERS.gemini
                        ? prev.model
                        : DEFAULT_MODELS[AI_PROVIDERS.gemini] }))
                }
              >
                <Text style={styles.settingsProviderButtonText}>Gemini</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.settingsProviderButton,
                  settingsDraft.provider === AI_PROVIDERS.openai && styles.settingsProviderButtonActive,
                ]}
                onPress={() =>
                  setSettingsDraft((prev) => ({
                    ...prev,
                    provider: AI_PROVIDERS.openai,
                    model:
                      prev.provider === AI_PROVIDERS.openai
                        ? prev.model
                        : DEFAULT_MODELS[AI_PROVIDERS.openai] }))
                }
              >
                <Text style={styles.settingsProviderButtonText}>ChatGPT</Text>
              </Pressable>
            </View>

            <Text style={styles.settingsLabel}>Model</Text>
            <TextInput
              style={styles.settingsInput}
              placeholder="e.g. gemini-2.0-flash or gpt-4o-mini"
              placeholderTextColor="#777"
              value={settingsDraft.model}
              onChangeText={(value) => setSettingsDraft((prev) => ({ ...prev, model: value }))}
              autoCapitalize="none"
            />

            <Text style={styles.settingsLabel}>API Key</Text>
            <TextInput
              style={styles.settingsInput}
              placeholder="Paste your API key"
              placeholderTextColor="#777"
              value={settingsDraft.apiKey}
              onChangeText={(value) => setSettingsDraft((prev) => ({ ...prev, apiKey: value }))}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />

            <Pressable style={styles.modalButton} onPress={saveAiSettings}>
              <Text style={styles.modalButtonText}>Save Settings</Text>
            </Pressable>
            <Text style={styles.settingsHint}>
              Active: {aiSettings.provider} • {aiSettings.model || 'No model'}
            </Text>

            <View style={styles.settingsDivider} />
            <Text style={styles.sectionTitle}>Study Settings</Text>
            <Text style={styles.settingsLabel}>Daily goal (words reviewed)</Text>
            <TextInput
              style={styles.settingsInput}
              placeholder={String(DEFAULT_DAILY_GOAL)}
              placeholderTextColor="#777"
              value={settingsDraft.dailyGoal}
              onChangeText={(value) =>
                setSettingsDraft((prev) => ({ ...prev, dailyGoal: value.replace(/[^0-9]/g, '') }))
              }
              keyboardType="number-pad"
            />
            <Text style={styles.settingsHint}>Today: {dailyReviewed}/{dailyGoal}</Text>

            <Pressable
              style={[styles.toggleRow, ttsSlow ? styles.toggleRowActive : null]}
              onPress={() => {
                const next = !ttsSlow;
                setTtsSlow(next);
                AsyncStorage.setItem(STORAGE_KEYS.ttsSlow, next ? 'true' : 'false').catch(() => {});
              }}
            >
              <Text style={styles.toggleRowText}>Slow pronunciation (TTS)</Text>
              <Text style={styles.toggleRowValue}>{ttsSlow ? 'On' : 'Off'}</Text>
            </Pressable>

            <Pressable style={styles.modalButton} onPress={() => speakWord('Pronunciation test')}>
              <Text style={styles.modalButtonText}>Test pronunciation</Text>
            </Pressable>
            <Pressable
              style={styles.modalButton}
              onPress={async () => {
                const ok = await ensureMicrophonePermission();
                Alert.alert('Microphone', ok ? 'Permission granted.' : 'Permission denied.');
              }}
            >
              <Text style={styles.modalButtonText}>Test microphone permission</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.deckListWrap}>
            {/* Global Progress Dashboard */}
            <View style={styles.dashboard}>
              <Text style={styles.dashboardTitle}>Overall Progress</Text>
              <Text style={styles.dashboardStats}>
                {globalCounts.mastered} Mastered • {allWordsCount} Total Words • Today {dailyReviewed}/{dailyGoal}
              </Text>
              <View style={styles.ringsRow}>
                {[
                  ['Mastered', 'mastered'],
                  ['Reviewing', 'reviewing'],
                  ['Learning', 'learning'],
                ].map(([label, key]) => (
                  <View key={key} style={styles.ringItem}>
                    <View style={[styles.progressRing, { borderColor: STATE_COLORS[key] }]}>
                      <Text style={styles.progressRingValue}>{globalPercentages[key]}%</Text>
                    </View>
                    <Text style={styles.ringLabel}>{label}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.compactProgressArea}>
                <View
                  style={[
                    styles.compactProgressSegment,
                    {
                      backgroundColor: STATE_COLORS.mastered,
                      flex: globalCounts.mastered || DASHBOARD_MIN_SEGMENT_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    {
                      backgroundColor: STATE_COLORS.reviewing,
                      flex: globalCounts.reviewing || DASHBOARD_MIN_SEGMENT_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    {
                      backgroundColor: STATE_COLORS.learning,
                      flex: globalCounts.learning || DASHBOARD_MIN_SEGMENT_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    {
                      backgroundColor: '#333',
                      flex: globalUnseenCount || 1 },
                  ]}
                />
              </View>
              <View style={styles.dashboardSegmentLegend}>
                {[
                  ['Mastered', 'mastered'],
                  ['Reviewing', 'reviewing'],
                  ['Learning', 'learning'],
                ].map(([label, key]) => (
                  <View key={key} style={styles.dashboardSegmentItem}>
                    <View style={[styles.dashboardSegmentDot, { backgroundColor: STATE_COLORS[key] }]} />
                    <Text
                      style={styles.dashboardSegmentText}
                      accessibilityLabel={`${label}: ${globalCounts[key]} of ${allWordsCount} words`}
                    >
                      {label}: {globalCounts[key]}/{allWordsCount}
                    </Text>
                  </View>
                ))}
              </View>
              <Pressable style={styles.resetAllButton} onPress={confirmResetAllProgress}>
                <Text style={styles.resetAllButtonText}>Reset all progress</Text>
              </Pressable>
            </View>

            {wordsNotice ? <Text style={styles.noticeText}>{wordsNotice}</Text> : null}

            {/* Search Bar */}
            <View style={styles.searchWrap}>
              <Text style={styles.searchIcon} accessible={false}>
                🔎
              </Text>
              <TextInput
                style={styles.searchInput}
                placeholder="Search words..."
                placeholderTextColor="#888"
                value={searchQuery}
                onChangeText={setSearchQuery}
                accessibilityLabel="Search words"
              />
            </View>

            {searchQuery ? (
              <FlatList
                data={filteredSearchWords}
                keyExtractor={(item) => `${item.word}-${item.__groupIndex}-${item.__wordIndex}`}
                contentContainerStyle={styles.deckListContent}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.searchResultItem}
                    onPress={async () => {
                      await openGroup(item.__groupIndex, item.__wordIndex);
                      setSearchQuery('');
                    }}
                  >
                    <View style={styles.searchResultTopRow}>
                      <Text style={styles.searchWord}>{item.word}</Text>
                      {bookmarks?.[item.word] ? <Text style={styles.searchStar}>★</Text> : null}
                    </View>
                    <Text style={styles.searchDef}>{item.definition}</Text>
                    <Text style={styles.searchDeckMeta}>{item.__groupName}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={<Text style={styles.infoText}>No words found.</Text>}
              />
            ) : (
              <FlatList
                data={groups}
                keyExtractor={(item, index) => `${item.group}-${index}`}
                contentContainerStyle={styles.deckListContent}
                renderItem={({ item, index }) => (
                  <View style={styles.deckButton}>
                    <Pressable style={styles.deckMainArea} onPress={() => openGroup(index)}>
                      <Text style={styles.deckTitle}>{item.group}</Text>
                      <Text style={styles.deckMeta}>
                        {groupDeckStats[item.group]?.total ?? item.words?.length ?? 0} words •{' '}
                        {groupDeckStats[item.group]?.mastered ?? 0} mastered • Resume{' '}
                        {groupDeckStats[item.group]?.total
                          ? (groupDeckStats[item.group]?.resumeIndex ?? 0) + 1
                          : 0}
                        /{groupDeckStats[item.group]?.total ?? item.words?.length ?? 0}
                      </Text>

                      <View style={styles.deckProgressBar}>
                        <View
                          style={{
                            backgroundColor: STATE_COLORS.mastered,
                            flex: groupDeckStats[item.group]?.mastered || DASHBOARD_MIN_SEGMENT_FLEX,
                            height: '100%',
                          }}
                        />
                        <View
                          style={{
                            backgroundColor: STATE_COLORS.reviewing,
                            flex: groupDeckStats[item.group]?.reviewing || DASHBOARD_MIN_SEGMENT_FLEX,
                            height: '100%',
                          }}
                        />
                        <View
                          style={{
                            backgroundColor: STATE_COLORS.learning,
                            flex: groupDeckStats[item.group]?.learning || DASHBOARD_MIN_SEGMENT_FLEX,
                            height: '100%',
                          }}
                        />
                        <View
                          style={{
                            backgroundColor: '#333',
                            flex: groupDeckStats[item.group]?.unseen || 1,
                            height: '100%',
                          }}
                        />
                      </View>

                      {groupDeckStats[item.group]?.resumeWord ? (
                        <Text style={styles.deckResumeText}>
                          Next up: {groupDeckStats[item.group]?.resumeWord}
                        </Text>
                      ) : null}
                    </Pressable>
                    <Pressable
                      style={styles.resetGroupButton}
                      onPress={() => confirmResetGroupProgress(item)}
                    >
                      <Text style={styles.resetGroupButtonText}>Reset</Text>
                    </Pressable>
                  </View>
                )}
              />
            )}
          </View>
        )}
      </View>
      <Modal visible={Boolean(quizSummary)} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Quiz Complete</Text>
            <Text style={styles.modalBody}>
              You answered {quizSummary?.correct}/{quizSummary?.total} correctly (
              {quizSummary?.accuracy}% accuracy).
            </Text>
            <Pressable
              style={styles.modalButton}
              onPress={() => {
                setQuizSummary(null);
                nextQuizWord();
              }}
            >
              <Text style={styles.modalButtonText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  base: { flex: 1, backgroundColor: '#050505' },
  container: { flex: 1, paddingHorizontal: 16, paddingBottom: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  appHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  appTitle: { color: '#fff', fontSize: 28 },
  settingsTopButton: { borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#111' },
  settingsTopButtonText: { color: '#fff', fontSize: 12 },
  sectionTitle: { color: '#fff', fontSize: 18, marginBottom: 12 },
  noticeText: { color: '#777', fontSize: 12, marginTop: -8, marginBottom: 12 },

  // Dashboard & Search
  dashboard: { backgroundColor: '#151515', borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#252525' },
  dashboardTitle: { color: '#fff', fontSize: 16 },
  dashboardStats: { color: '#bbb', fontSize: 13, marginBottom: 12 },
  ringsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  ringItem: { alignItems: 'center', gap: 6 },
  progressRing: { width: 66, height: 66, borderRadius: 33, borderWidth: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  progressRingValue: { color: '#fff', fontSize: 14 },
  ringLabel: { color: '#aaa', fontSize: 11 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#2f3240', backgroundColor: '#131722', marginBottom: 16, paddingHorizontal: 12 },
  searchIcon: { color: '#7f8aa3', fontSize: 15, marginRight: 8 },
  searchInput: { flex: 1, color: '#fff', paddingVertical: 14, fontSize: 15 },
  searchResultItem: { backgroundColor: '#111', padding: 14, borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: '#252525' },
  searchResultTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchWord: { color: '#fff', fontSize: 16 },
  searchStar: { color: '#fff', fontSize: 14 },
  searchDef: { color: '#aaa', fontSize: 13, marginTop: 4 },
  searchDeckMeta: { color: '#666', fontSize: 11, marginTop: 8 },

  // Decks
  deckListWrap: { flex: 1 },
  deckListContent: { paddingBottom: 20 },
  deckButton: { borderWidth: 1, borderColor: '#252525', borderRadius: 16, marginBottom: 12, backgroundColor: '#111', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  deckMainArea: { flex: 1, padding: 18 },
  deckTitle: { color: '#fff', fontSize: 17 },
  deckMeta: { color: '#888', marginTop: 4 },
  deckProgressBar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 10, backgroundColor: '#333' },
  deckResumeText: { color: '#777', fontSize: 12, marginTop: 8 },
  resetGroupButton: { marginRight: 14, borderWidth: 1, borderColor: '#444', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#171717' },
  resetGroupButtonText: { color: '#ddd', fontSize: 12 },

  // Header
  deckScreen: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  backText: { color: '#fff', fontSize: 14 },
  groupTitle: { color: '#fff', fontSize: 16 },
  deckFiltersRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  filterPill: { borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#111' },
  filterPillActive: { borderColor: '#fff', backgroundColor: '#1d1d1d' },
  filterPillText: { color: '#fff', fontSize: 12 },
  deckFiltersMeta: { color: '#777', fontSize: 12 },

  // Flashcards UI
  cardFlipContainer: { flex: 1, minHeight: CARD_MIN_HEIGHT },
  cardTapLayer: { flex: 1, minHeight: CARD_MIN_HEIGHT },
  card: { backgroundColor: '#111', borderRadius: 20, padding: 20, minHeight: CARD_MIN_HEIGHT, borderWidth: 1, borderColor: '#252525', justifyContent: 'center', overflow: 'hidden' },
  cardFace: { backfaceVisibility: 'hidden' },
  cardBack: { position: 'absolute', width: '100%', top: 0, left: 0, justifyContent: 'flex-start', paddingTop: CARD_BACK_TOP_PADDING, paddingBottom: 12 },
  cardTopRow: { position: 'absolute', top: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTopLeftRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  audioIcon: { backgroundColor: '#222', borderRadius: 20, padding: 8 },
  audioIconText: { fontSize: 18 },
  cardTag: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  cardTagText: { color: '#fff', fontSize: 11, textTransform: 'uppercase' },
  wordText: { color: '#fff', fontSize: 36, textAlign: 'center' },
  tapHint: { textAlign: 'center', color: '#666', fontSize: 14, marginTop: 16 },
  swipeHint: { textAlign: 'center', color: '#777', fontSize: 12, marginTop: 10 },

  // Card Details (Typography improvements)
  detailsScroll: { marginTop: 14, flex: 1 },
  detailsWrap: { gap: 12, paddingBottom: 8 },
  definitionText: { color: '#fff', fontSize: 18, lineHeight: 26, textAlign: 'center' },
  posText: { color: '#888', fontStyle: 'italic' },
  exampleText: { color: '#ddd', fontSize: 15, fontStyle: 'italic', textAlign: 'center' },
  mnemonicBox: { backgroundColor: '#1a1a1a', padding: 12, borderRadius: 12, marginTop: 8 },
  mnemonicTitle: { color: '#FF9800', fontSize: 12, textTransform: 'uppercase', marginBottom: 4 },
  mnemonicText: { color: '#eee', fontSize: 14, lineHeight: 20 },
  synonymsText: { color: '#aaa', fontSize: 13, textAlign: 'center', marginTop: 8 },

  // Progress UI
  compactProgressArea: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 16, backgroundColor: '#333' },
  compactProgressSegment: { height: '100%' },
  dashboardSegmentLegend: { marginTop: -4, marginBottom: 12, gap: 6 },
  dashboardSegmentItem: { flexDirection: 'row', alignItems: 'center' },
  dashboardSegmentDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dashboardSegmentText: { color: '#9ea5b5', fontSize: 12 },
  resetAllButton: { alignSelf: 'flex-end', borderWidth: 1, borderColor: '#444', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#111' },
  resetAllButtonText: { color: '#ddd', fontSize: 12 },

  // Action Buttons
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 24 },
  actionButton: { flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center', borderWidth: 1, backgroundColor: '#111' },
  actionText: { fontSize: 14 },

  // Modes & Quiz
  modeList: { gap: 12 },
  modeCard: { borderWidth: 1, borderColor: '#252525', borderRadius: 16, padding: 18, backgroundColor: '#111' },
  modeCardDisabled: { opacity: 0.5 },
  modeCardTitle: { color: '#fff', fontSize: 18 },
  modeCardMeta: { marginTop: 4, color: '#888', fontSize: 13 },

  quizWrap: { flex: 1, gap: 16 },
  quizPrompt: { color: '#888', textAlign: 'center', marginBottom: -10 },
  quizOptionsWrap: { gap: 10 },
  quizOption: { borderWidth: 1, borderColor: '#252525', borderRadius: 14, padding: 16, backgroundColor: '#111' },
  quizOptionCorrect: { borderColor: '#4CAF50', backgroundColor: '#1B2E20' },
  quizOptionWrong: { borderColor: '#F44336', backgroundColor: '#301818' },
  quizOptionText: { color: '#fff', fontSize: 15 },
  quizFeedback: { borderWidth: 1, borderColor: '#252525', borderRadius: 12, padding: 16, backgroundColor: '#111', alignItems: 'center' },
  quizFeedbackTitle: { color: '#F44336', fontSize: 16, marginBottom: 8 },
  quizFeedbackText: { color: '#ddd', fontSize: 14, textAlign: 'center', marginBottom: 12 },
  nextButton: { backgroundColor: '#333', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  nextButtonText: { color: '#fff' },
  speakingPanel: { borderWidth: 1, borderColor: '#252525', borderRadius: 12, padding: 14, backgroundColor: '#111', gap: 10 },
  speakingButton: { backgroundColor: '#2A2A2A' },
  speakingButtonActive: { backgroundColor: '#3B2A1A' },
  speakingCheckButton: { marginTop: 6, alignSelf: 'flex-start' },
  speakingTranscriptLabel: { color: '#aaa', fontSize: 12 },
  speakingTranscriptValue: { color: '#fff', fontSize: 14, minHeight: 42 },
  speakingError: { color: '#F44336', fontSize: 13 },
  speechResultCard: { borderWidth: 1, borderColor: '#2e2e2e', borderRadius: 10, padding: 12, backgroundColor: '#171717' },
  speechResultTitle: { fontSize: 16, marginBottom: 6 },
  speechResultGood: { color: '#4CAF50' },
  speechResultBad: { color: '#F44336' },
  quizScoreText: { color: '#888', textAlign: 'center' },
  infoText: { color: '#888', textAlign: 'center', marginTop: 20 },
  settingsScreen: { borderWidth: 1, borderColor: '#252525', borderRadius: 16, backgroundColor: '#111', padding: 16, gap: 10 },
  settingsProviderRow: { flexDirection: 'row', gap: 10, marginTop: 4, marginBottom: 6 },
  settingsProviderButton: { flex: 1, borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  settingsProviderButtonActive: { borderColor: '#fff', backgroundColor: '#1d1d1d' },
  settingsProviderButtonText: { color: '#fff' },
  settingsLabel: { color: '#bbb', fontSize: 13 },
  settingsInput: { borderWidth: 1, borderColor: '#2f2f2f', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#fff', backgroundColor: '#090909' },
  settingsHint: { color: '#777', fontSize: 12, marginTop: 4 },
  settingsDivider: { height: 1, backgroundColor: '#252525', marginVertical: 10 },
  toggleRow: { borderWidth: 1, borderColor: '#2f2f2f', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#090909', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggleRowActive: { borderColor: '#fff', backgroundColor: '#1d1d1d' },
  toggleRowText: { color: '#fff', fontSize: 14 },
  toggleRowValue: { color: '#bbb', fontSize: 12 },

  errorBox: { marginBottom: 12, borderWidth: 1, borderColor: '#301818', borderRadius: 12, padding: 12, backgroundColor: '#1A0B0B' },
  errorText: { color: '#F44336', marginBottom: 8 },
  retryButton: { borderWidth: 1, borderColor: '#F44336', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start' },
  retryText: { color: '#F44336' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 360, backgroundColor: '#111', borderRadius: 16, borderWidth: 1, borderColor: '#252525', padding: 18, gap: 12 },
  modalTitle: { color: '#fff', fontSize: 20 },
  modalBody: { color: '#ddd', fontSize: 14, lineHeight: 22 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  modalButton: { backgroundColor: '#333', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  modalButtonSecondary: { backgroundColor: '#222' },
  modalButtonText: { color: '#fff' } });
