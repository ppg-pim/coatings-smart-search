import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProductRecord = Record<string, any>

interface AIQueryPlan {
  intent: 'comparison' | 'lookup' | 'list' | 'count' | 'analytical'
  searchTerms: string[]
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  requiresMultipleProducts: boolean
  explanation: string
}

interface EnhancedQuery {
  originalQuery: string
  enhancedQuery: string
  searchIntent: string
  domainTerms: string[]
  technicalRequirements: string[]
  expectedProductTypes: string[]
  isProductCode?: boolean
  normalizedCode?: string
}

interface QueryAnalysis {
  isSingleWord: boolean
  isMultiWord: boolean
  wordCount: number
  requiresAllWords: boolean
  searchStrategy: 'semantic-first' | 'keyword-first' | 'hybrid'
  isProductCode: boolean
  normalizedCode?: string
  isSeries?: boolean
  seriesNumber?: string
  seriesModifier?: string
}

interface SimilarProduct {
  sku: string
  productModel: string
  productName: string
  family: string
  similarity: number
  distance: number
}

// Constants
const MAX_TOKENS = 30000
const SEMANTIC_SEARCH_LIMIT = 50
const MIN_SIMILARITY_THRESHOLD = 0.60
const MAX_SUGGESTIONS = 5
const CACHE_TTL = 1000 * 60 * 60 * 24

let schemaCache: string[] | null = null
let filterCache: any = null
const queryEnhancementCache = new Map<string, EnhancedQuery>()

// ============================================================================
// FUZZY MATCHING UTILITIES
// ============================================================================

function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length
  const len2 = str2.length
  const matrix: number[][] = []

  for (let i = 0; i <= len1; i++) matrix[i] = [i]
  for (let j = 0; j <= len2; j++) matrix[0][j] = j

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }
  return matrix[len1][len2]
}

function calculateSimilarity(str1: string, str2: string): number {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase())
  const maxLength = Math.max(str1.length, str2.length)
  return 1 - (distance / maxLength)
}

async function findSimilarProducts(
  query: string,
  minSimilarity: number = MIN_SIMILARITY_THRESHOLD,
  limit: number = MAX_SUGGESTIONS
): Promise<SimilarProduct[]> {
  console.log(`🔍 Searching for products similar to: "${query}"`)

  try {
    const queryNormalized = query.replace(/[\s-]/g, '').toUpperCase()
    const queryLength = queryNormalized.length
    const firstChars = queryNormalized.substring(0, 2)
    const lastChars = queryNormalized.substring(queryNormalized.length - 2)

    console.log(`   Query normalized: "${queryNormalized}" (length: ${queryLength})`)

    let query_builder = supabase
      .from('coatings')
      .select('sku, Product_Model, Product_Name, family')

    const orConditions: string[] = []
    orConditions.push(`sku.ilike.${firstChars}%`)
    orConditions.push(`Product_Model.ilike.${firstChars}%`)
    orConditions.push(`sku.ilike.%${lastChars}%`)
    orConditions.push(`Product_Model.ilike.%${lastChars}%`)

    const letterMatch = queryNormalized.match(/(\d+)([A-Z])(\d+)/)
    if (letterMatch) {
      const [_, prefix, letter, suffix] = letterMatch
      orConditions.push(`sku.ilike.%${letter}${suffix}%`)
      orConditions.push(`Product_Model.ilike.%${letter}${suffix}%`)
      orConditions.push(`sku.ilike.${prefix}${letter}%`)
      orConditions.push(`Product_Model.ilike.${prefix}${letter}%`)
    }

    query_builder = query_builder.or(orConditions.join(','))
    query_builder = query_builder.limit(500)

    const { data, error } = await query_builder

    if (error || !data) {
      console.error('❌ Error fetching products for fuzzy match:', error)
      return []
    }

    console.log(`   📊 Fetched ${data.length} candidate products`)

    const similarities: SimilarProduct[] = []

    data.forEach(product => {
      const sku = (product.sku || '').replace(/[\s-]/g, '').toUpperCase()
      const model = (product.Product_Model || '').replace(/[\s-]/g, '').toUpperCase()

      const skuSimilarity = calculateSimilarity(queryNormalized, sku)
      const modelSimilarity = calculateSimilarity(queryNormalized, model)

      const skuContains = sku.includes(queryNormalized) || queryNormalized.includes(sku)
      const modelContains = model.includes(queryNormalized) || queryNormalized.includes(model)

      let adjustedSkuSim = skuSimilarity
      let adjustedModelSim = modelSimilarity

      if (skuContains && skuSimilarity < 0.9) adjustedSkuSim = Math.max(skuSimilarity, 0.75)
      if (modelContains && modelSimilarity < 0.9) adjustedModelSim = Math.max(modelSimilarity, 0.75)

      const bestSimilarity = Math.max(adjustedSkuSim, adjustedModelSim)
      const distance = levenshteinDistance(queryNormalized, model.length > 0 ? model : sku)

      if (bestSimilarity >= minSimilarity && bestSimilarity < 0.98) {
        similarities.push({
          sku: product.sku,
          productModel: product.Product_Model,
          productName: product.Product_Name,
          family: product.family,
          similarity: bestSimilarity,
          distance
        })
      }
    })

    similarities.sort((a, b) => {
      if (Math.abs(a.similarity - b.similarity) > 0.05) {
        return b.similarity - a.similarity
      }
      return a.distance - b.distance
    })

    const topSimilar = similarities.slice(0, limit)

    if (topSimilar.length > 0) {
      console.log(`✅ Found ${topSimilar.length} similar products:`)
      topSimilar.forEach(s => {
        console.log(`   - ${s.productModel || s.sku} (${(s.similarity * 100).toFixed(0)}% match)`)
      })
    }

    return topSimilar
  } catch (error) {
    console.error('❌ Fuzzy matching failed:', error)
    return []
  }
}

function shouldAskForClarification(
  products: ProductRecord[],
  query: string,
  queryAnalysis: QueryAnalysis
): boolean {
  if (queryAnalysis.isProductCode) {
    if (products.length === 0) {
      console.log(`   ❓ Triggering clarification: No products found`)
      return true
    }

    const queryNorm = query.replace(/[\s-]/g, '').toUpperCase()
    const queryLength = queryNorm.length

    console.log(`   🔍 Checking high-confidence match for: "${queryNorm}"`)

    const hasHighConfidenceMatch = products.some(p => {
      const model = (p.Product_Model || '').replace(/[\s-]/g, '').toUpperCase()
      const sku = (p.sku || '').replace(/[\s-]/g, '').toUpperCase()

      const exactMatch = model === queryNorm || sku === queryNorm
      const startsWithMatch = model.startsWith(queryNorm) || sku.startsWith(queryNorm)

      const lengthDiff = Math.abs(model.length - queryLength)
      const lengthSimilar = lengthDiff <= 2

      const containsMatch = lengthSimilar && (
        model.includes(queryNorm) || sku.includes(queryNorm)
      )

      let similarity = 0
      if (exactMatch) {
        similarity = 1.0
        console.log(`   ✅ EXACT MATCH: ${model || sku}`)
      } else if (startsWithMatch) {
        similarity = 0.9
        console.log(`   ✅ STARTS WITH: ${model || sku}`)
      } else if (containsMatch) {
        const modelSim = calculateSimilarity(queryNorm, model)
        const skuSim = calculateSimilarity(queryNorm, sku)
        similarity = Math.max(modelSim, skuSim)
        console.log(`   ⚠️  CONTAINS: ${model || sku} (${(similarity * 100).toFixed(0)}%)`)
      }

      return similarity >= 0.80
    })

    if (!hasHighConfidenceMatch) {
      console.log(`   ❓ No high-confidence match (≥80% similarity)`)
      return true
    }

    console.log(`   ✅ High-confidence match found`)
  }

  return false
}

// ============================================================================
// PRODUCT CODE DETECTION
// ============================================================================

function detectAndNormalizeProductCode(query: string): {
  isProductCode: boolean
  normalizedCode?: string
  prefix?: string
  number?: string
  isSeries?: boolean
  seriesNumber?: string
  seriesModifier?: string
} {
  // Pattern 1: CA 8100, PR 1776 (prefix + space + number)
  const pattern1 = query.match(/\b([A-Z]{2,3})\s*[-\s]*(\d{4,})\b/i)
  
  // Pattern 2: CA-8100 (prefix + hyphen + number)
  const pattern2 = query.match(/\b([A-Z]{2,3})-(\d{4,})\b/i)
  
  // Pattern 3: CA8100 (prefix + number, no separator)
  const pattern3 = query.match(/\b([A-Z]{2,3})(\d{4,})\b/i)

  // Pattern 4: 02Y04, 02Y024 (digits + letter + digits) ✅ NEW
  const pattern4 = query.match(/\b(\d{2})([A-Z])(\d{2,3})\b/i)

  // Pattern 5: Y-123 (single letter + hyphen + digits) ✅ NEW
  const pattern5 = query.match(/\b([A-Z])-(\d{3,})\b/i)

  // Pattern 6: 123Y456 (digits + letter + digits, longer) ✅ NEW
  const pattern6 = query.match(/\b(\d{1,3})([A-Z]{1,2})(\d{2,4})\b/i)

  // Series pattern: "01 series HS", "99 series"
  const seriesPattern = query.match(/\b(\d{2,4})\s*series\s*([A-Z]{0,3})\b/i)

  if (seriesPattern) {
    const seriesNumber = seriesPattern[1]
    const seriesModifier = seriesPattern[2] || ''
    const normalizedCode = seriesModifier 
      ? `${seriesNumber}SERIES${seriesModifier}` 
      : `${seriesNumber}SERIES`
    
    console.log(`🔍 Detected series: "${query}" → "${normalizedCode}"`)
    
    return {
      isProductCode: true,
      isSeries: true,
      seriesNumber,
      seriesModifier,
      normalizedCode
    }
  }

  if (pattern4) {
    const [_, prefix, letter, suffix] = pattern4
    const normalizedCode = `${prefix}${letter}${suffix}`
    console.log(`🔍 Detected product code (Pattern 4): "${query}" → Normalized: "${normalizedCode}" (Format: ${prefix}-${letter}-${suffix})`)
    return {
      isProductCode: true,
      normalizedCode,
      prefix,
      number: suffix
    }
  }

  if (pattern5) {
    const [_, letter, number] = pattern5
    const normalizedCode = `${letter}${number}`
    console.log(`🔍 Detected product code (Pattern 5): "${query}" → "${normalizedCode}"`)
    return {
      isProductCode: true,
      normalizedCode,
      prefix: letter,
      number
    }
  }

  if (pattern6) {
    const [_, prefix, letter, suffix] = pattern6
    const normalizedCode = `${prefix}${letter}${suffix}`
    console.log(`🔍 Detected product code (Pattern 6): "${query}" → "${normalizedCode}"`)
    return {
      isProductCode: true,
      normalizedCode,
      prefix,
      number: suffix
    }
  }

  if (pattern1 || pattern2 || pattern3) {
    const match = pattern1 || pattern2 || pattern3
    const [_, prefix, number] = match!
    const normalizedCode = `${prefix}${number}`
    console.log(`🔍 Detected product code: "${query}" → "${normalizedCode}"`)
    return {
      isProductCode: true,
      normalizedCode,
      prefix,
      number
    }
  }

  return { isProductCode: false }
}

// ============================================================================
// MULTI-PRODUCT COMPARISON SEARCH ✅ NEW
// ============================================================================

async function searchMultipleProducts(
  productCodes: string[],
  appliedFilters: any
): Promise<ProductRecord[]> {
  console.log(`\n🔍 Searching for ${productCodes.length} specific products: ${productCodes.join(', ')}`)

  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()

  for (const code of productCodes) {
    const cleanCode = code.trim().toUpperCase()
    if (!cleanCode) continue

    console.log(`\n  🔎 Searching for: "${cleanCode}"`)

    try {
      let query = supabase.from('coatings').select('*')

      // Apply user filters
      if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
      if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
      if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

      const normalizedCode = cleanCode.replace(/[\s-]/g, '')
      
      const orConditions: string[] = []
      
      // Exact matches
      orConditions.push(`sku.eq.${cleanCode}`)
      orConditions.push(`Product_Model.eq.${cleanCode}`)
      
      // ILIKE matches
      orConditions.push(`sku.ilike.${cleanCode}`)
      orConditions.push(`sku.ilike.${normalizedCode}`)
      orConditions.push(`Product_Model.ilike.${cleanCode}`)
      orConditions.push(`Product_Model.ilike.${normalizedCode}`)
      orConditions.push(`Product_Name.ilike.%${cleanCode}%`)
      
      // Handle variants (02Y024A, 02Y024B, etc.)
      if (cleanCode.length >= 5) {
        const baseCode = cleanCode.substring(0, cleanCode.length - 1)
        orConditions.push(`sku.ilike.${baseCode}%`)
        orConditions.push(`Product_Model.ilike.${baseCode}%`)
      }

      query = query.or(orConditions.join(','))
      query = query.limit(20)

      const { data, error } = await query

      if (error) {
        console.error(`  ❌ Error searching for "${cleanCode}":`, error)
        continue
      }

      if (data && data.length > 0) {
        console.log(`  ✅ Found ${data.length} match(es) for "${cleanCode}"`)
        
        data.forEach((item: any) => {
          const id = item.sku || JSON.stringify(item)
          if (!seenIds.has(id)) {
            seenIds.add(id)
            allResults.push({
              ...item,
              _searchTerm: cleanCode,
              _source: 'exact-match',
              _score: 1000
            })
          }
        })
      } else {
        console.log(`  ⚠️ No matches found for "${cleanCode}"`)
      }
    } catch (err) {
      console.error(`  ❌ Exception searching for "${cleanCode}":`, err)
    }
  }

  console.log(`\n✅ Total products found: ${allResults.length}`)
  
  return allResults
}

// ============================================================================
// AI QUERY ENHANCEMENT
// ============================================================================

async function enhanceQueryWithAI(query: string): Promise<EnhancedQuery> {
  // Check cache first
  const cacheKey = query.toLowerCase().trim()
  if (queryEnhancementCache.has(cacheKey)) {
    console.log('✅ Using cached query enhancement')
    return queryEnhancementCache.get(cacheKey)!
  }

  console.log(`🧠 AI enhancing query: "${query}"`)

  const productCodeInfo = detectAndNormalizeProductCode(query)

  try {
    const systemPrompt = `You are an aerospace coatings expert. Enhance search queries to find relevant coating products.

Extract:
1. Technical terms (e.g., "high temperature", "fuel resistant")
2. Product types (e.g., "sealant", "primer", "topcoat")
3. Applications (e.g., "fuel tank", "exterior", "cabin")
4. Search intent

Return JSON:
{
  "enhancedQuery": "expanded query with technical terms",
  "searchIntent": "what user is looking for",
  "domainTerms": ["term1", "term2"],
  "technicalRequirements": ["req1", "req2"],
  "expectedProductTypes": ["type1", "type2"]
}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${query}"` }
      ],
      temperature: 0.3,
      max_tokens: 500
    })

    const content = completion.choices[0].message.content || '{}'
    const parsed = JSON.parse(content)

    const enhanced: EnhancedQuery = {
      originalQuery: query,
      enhancedQuery: parsed.enhancedQuery || query,
      searchIntent: parsed.searchIntent || 'general search',
      domainTerms: parsed.domainTerms || [],
      technicalRequirements: parsed.technicalRequirements || [],
      expectedProductTypes: parsed.expectedProductTypes || [],
      isProductCode: productCodeInfo.isProductCode,
      normalizedCode: productCodeInfo.normalizedCode
    }

    console.log(`✅ Query enhanced:`)
    console.log(`   Original: "${query}"`)
    console.log(`   Enhanced: "${enhanced.enhancedQuery.substring(0, 100)}..."`)
    console.log(`   Intent: ${enhanced.searchIntent}`)
    console.log(`   Is Product Code: ${enhanced.isProductCode ? 'YES ✅' : 'NO'}`)
    if (enhanced.normalizedCode) {
      console.log(`   Normalized Code: ${enhanced.normalizedCode}`)
    }

    // Cache for 1 hour
    queryEnhancementCache.set(cacheKey, enhanced)
    setTimeout(() => queryEnhancementCache.delete(cacheKey), 1000 * 60 * 60)

    return enhanced
  } catch (error) {
    console.error('❌ Query enhancement failed:', error)
    return {
      originalQuery: query,
      enhancedQuery: query,
      searchIntent: 'general search',
      domainTerms: [],
      technicalRequirements: [],
      expectedProductTypes: [],
      isProductCode: productCodeInfo.isProductCode,
      normalizedCode: productCodeInfo.normalizedCode
    }
  }
}

// ============================================================================
// AI QUERY ANALYSIS
// ============================================================================

async function analyzeQueryWithAI(query: string): Promise<AIQueryPlan> {
  console.log(`🧠 AI analyzing query intent: "${query}"`)

  try {
    const systemPrompt = `You are a query analyzer for aerospace coatings search. Analyze user intent and extract search terms.

Intents:
- comparison: User wants to compare multiple products (e.g., "compare CA8100 vs CA9321")
- lookup: User wants info on specific product(s) (e.g., "tell me about PR1776")
- list: User wants a list of products (e.g., "show me all fuel tank sealants")
- count: User wants to know how many (e.g., "how many primers do we have")
- analytical: User wants analysis (e.g., "what's the difference between...")

Return JSON:
{
  "intent": "comparison|lookup|list|count|analytical",
  "searchTerms": ["term1", "term2"],
  "filters": {"family": "", "productType": "", "productModel": ""},
  "requiresMultipleProducts": true/false,
  "explanation": "brief explanation"
}

Extract ALL product codes mentioned. For "Compare 02Y024, 02Y024A, 02Y024B", return searchTerms: ["02Y024", "02Y024A", "02Y024B"]`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${query}"` }
      ],
      temperature: 0.3,
      max_tokens: 500
    })

    const content = completion.choices[0].message.content || '{}'
    const parsed = JSON.parse(content)

    const plan: AIQueryPlan = {
      intent: parsed.intent || 'lookup',
      searchTerms: parsed.searchTerms || [query],
      filters: parsed.filters || {},
      requiresMultipleProducts: parsed.requiresMultipleProducts || false,
      explanation: parsed.explanation || ''
    }

    console.log(`✅ Query plan:`)
    console.log(`   Intent: ${plan.intent}`)
    console.log(`   Search Terms: ${plan.searchTerms.join(', ')}`)
    console.log(`   Requires Multiple: ${plan.requiresMultipleProducts}`)

    return plan
  } catch (error) {
    console.error('❌ Query analysis failed:', error)
    return {
      intent: 'lookup',
      searchTerms: [query],
      requiresMultipleProducts: false,
      explanation: 'Fallback to simple lookup'
    }
  }
}

// ============================================================================
// SEMANTIC SEARCH
// ============================================================================

async function performSemanticSearch(
  query: string,
  appliedFilters: any,
  limit: number = SEMANTIC_SEARCH_LIMIT
): Promise<ProductRecord[]> {
  console.log(`\n🔍 Performing semantic search: "${query}"`)

  try {
    // Generate embedding
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    })

    const embedding = embeddingResponse.data[0].embedding

    // Call Supabase RPC function
    const { data, error } = await supabase.rpc('match_coatings', {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: limit
    })

    if (error) {
      console.error('❌ Semantic search error:', error)
      return []
    }

    if (!data || data.length === 0) {
      console.log('⚠️ No semantic results found')
      return []
    }

    console.log(`✅ Found ${data.length} semantic matches`)

    // Deduplicate by family (keep best match per family)
    const familyMap = new Map<string, any>()
    
    data.forEach((product: any) => {
      const family = product.family || 'Unknown'
      const existing = familyMap.get(family)
      
      if (!existing || product.similarity > existing.similarity) {
        familyMap.set(family, product)
      }
    })

    const deduplicated = Array.from(familyMap.values())
    console.log(`📊 Deduplicated to ${deduplicated.length} families`)

    return deduplicated
  } catch (error) {
    console.error('❌ Semantic search failed:', error)
    return []
  }
}

// ============================================================================
// KEYWORD SEARCH
// ============================================================================

async function performKeywordSearch(
  query: string,
  appliedFilters: any,
  limit: number = 100
): Promise<ProductRecord[]> {
  console.log(`\n🔍 Performing keyword search: "${query}"`)

  try {
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2)

    console.log(`   Keywords: ${keywords.join(', ')}`)

    let queryBuilder = supabase.from('coatings').select('*')

    // Apply filters
    if (appliedFilters.family) queryBuilder = queryBuilder.eq('family', appliedFilters.family)
    if (appliedFilters.productType) queryBuilder = queryBuilder.eq('Product_Type', appliedFilters.productType)
    if (appliedFilters.productModel) queryBuilder = queryBuilder.eq('Product_Model', appliedFilters.productModel)

    // Build OR conditions for keywords
    const orConditions: string[] = []
    
    keywords.forEach(keyword => {
      orConditions.push(`sku.ilike.%${keyword}%`)
      orConditions.push(`Product_Model.ilike.%${keyword}%`)
      orConditions.push(`Product_Name.ilike.%${keyword}%`)
      orConditions.push(`Product_Description.ilike.%${keyword}%`)
      orConditions.push(`family.ilike.%${keyword}%`)
    })

    if (orConditions.length > 0) {
      queryBuilder = queryBuilder.or(orConditions.join(','))
    }

    queryBuilder = queryBuilder.limit(limit)

    const { data, error } = await queryBuilder

    if (error) {
      console.error('❌ Keyword search error:', error)
      return []
    }

    console.log(`✅ Found ${data?.length || 0} keyword matches`)

    return data || []
  } catch (error) {
    console.error('❌ Keyword search failed:', error)
    return []
  }
}

// ============================================================================
// SMART SEARCH ORCHESTRATOR ✅ IMPROVED
// ============================================================================

async function executeSmartSearch(
  plan: AIQueryPlan,
  appliedFilters: any,
  enhancedQuery: EnhancedQuery | null = null
): Promise<ProductRecord[]> {
  console.log(`⚡ Executing smart search for: ${plan.searchTerms.join(', ')}`)

  // ✅ SPECIAL HANDLING FOR COMPARISON QUERIES
  if (plan.intent === 'comparison' && plan.searchTerms.length > 1) {
    console.log(`\n🔀 Comparison query detected - searching for ${plan.searchTerms.length} individual products`)
    
    const products = await searchMultipleProducts(plan.searchTerms, appliedFilters)
    
    if (products.length > 0) {
      console.log(`✅ Found ${products.length} products for comparison`)
      return products
    } else {
      console.log(`⚠️ No products found for comparison - trying fuzzy matching...`)
      
      // Try fuzzy matching for each term
      const suggestions: ProductRecord[] = []
      
      for (const term of plan.searchTerms) {
        const similar = await findSimilarProducts(term, 0.70, 3)
        if (similar.length > 0) {
          const suggestionSKUs = similar.map(s => s.sku)
          const { data } = await supabase
            .from('coatings')
            .select('*')
            .in('sku', suggestionSKUs)
            .limit(3)
          
          if (data) {
            data.forEach(product => {
              product._isSuggestion = true
              product._originalQuery = term
              product._similarityScore = similar.find(s => s.sku === product.sku)?.similarity || 0
              suggestions.push(product)
            })
          }
        }
      }
      
      if (suggestions.length > 0) {
        console.log(`✅ Found ${suggestions.length} suggestions across all search terms`)
        return suggestions
      }
      
      console.log(`❌ No matches or suggestions found for any product codes`)
      return []
    }
  }

  // ✅ SINGLE PRODUCT OR GENERAL SEARCH
  const searchQuery = enhancedQuery?.enhancedQuery || plan.searchTerms.join(' ')
  const productCodeInfo = detectAndNormalizeProductCode(searchQuery)

  const queryAnalysis: QueryAnalysis = {
    isSingleWord: plan.searchTerms.length === 1 && !plan.searchTerms[0].includes(' '),
    isMultiWord: plan.searchTerms.length > 1 || plan.searchTerms[0].includes(' '),
    wordCount: plan.searchTerms.length,
    requiresAllWords: plan.intent === 'lookup',
    searchStrategy: productCodeInfo.isProductCode ? 'keyword-first' : 'semantic-first',
    isProductCode: productCodeInfo.isProductCode,
    normalizedCode: productCodeInfo.normalizedCode,
    isSeries: productCodeInfo.isSeries,
    seriesNumber: productCodeInfo.seriesNumber,
    seriesModifier: productCodeInfo.seriesModifier
  }

  console.log(`📊 Query Analysis:`)
  console.log(`   Strategy: ${queryAnalysis.searchStrategy}`)
  console.log(`   Is Product Code: ${queryAnalysis.isProductCode}`)

  let allResults: ProductRecord[] = []

  // Strategy 0: Exact SKU/Product Code match (instant return)
  if (queryAnalysis.isProductCode && queryAnalysis.normalizedCode) {
    console.log(`\n🎯 Strategy 0: Exact product code lookup`)
    
    const exactResults = await searchMultipleProducts([queryAnalysis.normalizedCode], appliedFilters)
    
    if (exactResults.length > 0) {
      console.log(`✅ Found exact match - returning immediately`)
      return exactResults
    }
    
    console.log(`⚠️ No exact match found for product code`)
  }

  // Strategy 1: Semantic search (skip for unmatched product codes)
  if (queryAnalysis.searchStrategy === 'semantic-first' || !queryAnalysis.isProductCode) {
    console.log(`\n🎯 Strategy 1: Semantic search`)
    const semanticResults = await performSemanticSearch(searchQuery, appliedFilters)
    allResults.push(...semanticResults)
  } else if (queryAnalysis.isProductCode) {
    console.log(`\n⏭️  Skipping semantic search for unmatched product code`)
  }

  // Strategy 2: Keyword search (fallback)
  if (allResults.length < 5) {
    console.log(`\n🎯 Strategy 2: Keyword search (fallback)`)
    const keywordResults = await performKeywordSearch(searchQuery, appliedFilters)
    allResults.push(...keywordResults)
  }

  // Remove duplicates
  const seen = new Set<string>()
  allResults = allResults.filter(p => {
    const id = p.sku || JSON.stringify(p)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  console.log(`\n📊 Total results before clarification check: ${allResults.length}`)

  // ✅ Check if we should ask for clarification
  if (shouldAskForClarification(allResults, searchQuery, queryAnalysis)) {
    console.log(`\n💡 Low confidence - searching for similar products...`)
    
    const similar = await findSimilarProducts(searchQuery, 0.60, MAX_SUGGESTIONS)
    
    if (similar.length > 0) {
      const suggestionSKUs = similar.map(s => s.sku)
      const { data } = await supabase
        .from('coatings')
        .select('*')
        .in('sku', suggestionSKUs)
      
      if (data && data.length > 0) {
        console.log(`✅ Found ${data.length} suggestions`)
        return data.map((product, index) => ({
          ...product,
          _isSuggestion: true,
          _originalQuery: searchQuery,
          _similarityScore: similar[index]?.similarity || 0
        }))
      }
    }
  }

  return allResults
}

// ============================================================================
// ANSWER GENERATION
// ============================================================================

async function generateAnswer(
  query: string,
  products: ProductRecord[],
  intent: string,
  enhancedQuery: EnhancedQuery | null
): Promise<string> {
  console.log(`🤖 Generating AI answer...`)

  // Check if these are suggestions
  const isSuggestion = products.some(p => p._isSuggestion)

  if (isSuggestion) {
    // Generate "Did You Mean?" response
    const suggestions = products
      .filter(p => p._isSuggestion)
      .slice(0, MAX_SUGGESTIONS)
      .map(p => {
        const score = (p._similarityScore * 100).toFixed(0)
        return `- **${p.Product_Model || p.sku}** - ${p.Product_Name} (${score}% match)`
      })
      .join('\n')

    return `I couldn't find an exact match for "${query}". Did you mean one of these?\n\n${suggestions}\n\nPlease click on a product above or refine your search.`
  }

  // Regular answer generation
  const productSummaries = products.slice(0, 20).map(p => {
    return `- ${p.Product_Model || p.sku}: ${p.Product_Name || 'N/A'} (${p.family || 'N/A'})`
  }).join('\n')

  const systemPrompt = `You are an aerospace coatings expert. Provide helpful, accurate answers about coating products.

Guidelines:
- Be concise but informative
- Mention specific product codes when relevant
- Highlight key features and applications
- Use markdown formatting
- If comparing products, create a comparison table
- If user asked about a specific product, focus on that product`

  const userPrompt = `User Query: "${query}"

Found ${products.length} products:
${productSummaries}

Intent: ${intent}
${enhancedQuery ? `Enhanced Query: ${enhancedQuery.enhancedQuery}` : ''}

Provide a helpful answer based on the products found.`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    })

    const answer = completion.choices[0].message.content || 'No answer generated'
    console.log(`✅ Answer generated (${answer.length} chars)`)
    return answer
  } catch (error) {
    console.error('❌ Answer generation failed:', error)
    return `Found ${products.length} products matching your query. Please review the results below.`
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}

  Object.entries(product).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') {
        let cleanedValue = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<li>/gi, '• ')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&reg;/gi, '®')
          .replace(/&trade;/gi, '™')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/\n{3,}/g, '\n\n')
          .trim()

        if (cleanedValue !== '') {
          cleaned[key] = cleanedValue
        }
      } else {
        cleaned[key] = value
      }
    }
  })

  return cleaned
}

async function getFilterOptions(): Promise<any> {
  if (filterCache && (Date.now() - filterCache.timestamp) < CACHE_TTL) {
    return {
      success: true,
      cached: true,
      filterOptions: {
        families: filterCache.families,
        productTypes: filterCache.productTypes,
        productModels: filterCache.productModels
      }
    }
  }

  try {
    const { data: families } = await supabase
      .from('coatings')
      .select('family')
      .not('family', 'is', null)
      .order('family')

    const { data: types } = await supabase
      .from('coatings')
      .select('Product_Type')
      .not('Product_Type', 'is', null)
      .order('Product_Type')

    const { data: models } = await supabase
      .from('coatings')
      .select('Product_Model')
      .not('Product_Model', 'is', null)
      .order('Product_Model')

    const uniqueFamilies = [...new Set(families?.map(f => f.family) || [])]
    const uniqueTypes = [...new Set(types?.map(t => t.Product_Type) || [])]
    const uniqueModels = [...new Set(models?.map(m => m.Product_Model) || [])]

    filterCache = {
      families: uniqueFamilies,
      productTypes: uniqueTypes,
      productModels: uniqueModels,
      timestamp: Date.now()
    }

    return {
      success: true,
      cached: false,
      filterOptions: {
        families: uniqueFamilies,
        productTypes: uniqueTypes,
        productModels: uniqueModels
      }
    }
  } catch (error) {
    console.error('❌ Error fetching filter options:', error)
    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: { families: [], productTypes: [], productModels: [] }
    }
  }
}

// ============================================================================
// API HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  try {
    const body = await req.json()
    const { query, filters = {} } = body

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return NextResponse.json({
        success: false,
        error: 'Query is required',
        answer: 'Please provide a search query.',
        products: []
      }, { status: 400 })
    }

    console.log('=' .repeat(80))
    console.log(`🔍 User query: ${query}`)

    // Special command: Get filter options
    if (query.trim() === '__GET_FILTER_OPTIONS__') {
      const filterOptions = await getFilterOptions()
      return NextResponse.json(filterOptions)
    }

    const appliedFilters = {
      family: filters.family || '',
      productType: filters.productType || '',
      productModel: filters.productModel || ''
    }

    // Step 1: Enhance query
    const enhancedQuery = await enhanceQueryWithAI(query)

    // Step 2: Analyze intent
    const queryPlan = await analyzeQueryWithAI(query)

    console.log(`> 🎯 Intent: ${queryPlan.intent}`)
    console.log(`> 🔑 Search terms: ${queryPlan.searchTerms.join(', ')}`)

    // Step 3: Execute search
    const products = await executeSmartSearch(queryPlan, appliedFilters, enhancedQuery)

    console.log(`> ✅ Found ${products.length} products`)

    // Step 4: Generate answer
    const answer = await generateAnswer(query, products, queryPlan.intent, enhancedQuery)

    const cleanedProducts = products.map(cleanProductData)

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log('=' .repeat(80))
    console.log(`✅ Completed in ${elapsedTime}s`)

    return NextResponse.json({
      success: true,
      answer,
      products: cleanedProducts,
      metadata: {
        totalResults: products.length,
        intent: queryPlan.intent,
        searchTerms: queryPlan.searchTerms,
        executionTime: `${elapsedTime}s`,
        hasSuggestions: products.some(p => p._isSuggestion)
      }
    })

  } catch (error: any) {
    console.error('❌ API Error:', error)

    return NextResponse.json({
      success: false,
      error: error.message || 'Internal server error',
      answer: 'An error occurred. Please try again.',
      products: []
    }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({
    success: true,
    message: 'Smart Coatings Search API v2.0',
    features: [
      'Multi-product comparison',
      'Fuzzy matching with suggestions',
      '6 product code patterns',
      'Semantic search',
      'AI-powered enhancement'
    ]
  })
}
